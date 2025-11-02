const express = require('express');
const fs = require('fs');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8000;

app.use(express.json());
app.use(express.static('public'));

const activeSessions = new Map();

// Simple UI
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>WhatsApp Auth</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .card {
          background: white;
          padding: 40px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
        }
        h1 { color: #25d366; text-align: center; margin-bottom: 30px; }
        input {
          width: 100%;
          padding: 15px;
          border: 2px solid #ddd;
          border-radius: 10px;
          font-size: 16px;
          margin-bottom: 15px;
        }
        input:focus { outline: none; border-color: #25d366; }
        button {
          width: 100%;
          padding: 15px;
          background: #25d366;
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 18px;
          font-weight: 600;
          cursor: pointer;
        }
        button:hover { background: #128c7e; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        .result {
          margin-top: 20px;
          padding: 20px;
          border-radius: 10px;
          text-align: center;
        }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .code {
          font-size: 40px;
          font-weight: bold;
          color: #25d366;
          margin: 15px 0;
          letter-spacing: 8px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🔐 WhatsApp Auth</h1>
        <input type="text" id="phone" placeholder="91XXXXXXXXXX" maxlength="15">
        <button onclick="getCode()" id="btn">Get Pairing Code</button>
        <div id="result"></div>
      </div>
      <script>
        async function getCode() {
          const phone = document.getElementById('phone').value.trim();
          const btn = document.getElementById('btn');
          const result = document.getElementById('result');
          
          if (!phone || phone.length < 10) {
            result.innerHTML = '<div class="result error">❌ Enter valid phone</div>';
            return;
          }
          
          btn.disabled = true;
          btn.textContent = '⏳ Wait...';
          result.innerHTML = '<div class="result">Generating...</div>';
          
          try {
            const res = await fetch('/request-pairing-code', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phoneNumber: phone })
            });
            
            const data = await res.json();
            
            if (data.success) {
              result.innerHTML = \`
                <div class="result success">
                  <h3>✅ Code Generated!</h3>
                  <div class="code">\${data.pairingCode}</div>
                  <p>Enter in WhatsApp:<br>Settings → Linked Devices → Link with phone number</p>
                  <p style="margin-top:10px;"><strong>Files will be sent automatically!</strong></p>
                </div>
              \`;
            } else {
              result.innerHTML = \`<div class="result error">❌ \${data.message}</div>\`;
            }
          } catch (err) {
            result.innerHTML = '<div class="result error">❌ Connection failed</div>';
          } finally {
            btn.disabled = false;
            btn.textContent = 'Get Pairing Code';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Initialize WhatsApp
async function initWhatsApp(sessionId, phoneNumber) {
  const sessionPath = `./sessions/${sessionId}`;
  
  try {
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'fatal' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      getMessage: async (key) => ({ conversation: 'hello' })
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      console.log(`[${sessionId.substring(0,6)}] Status: ${connection || 'undefined'}`);

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`[${sessionId.substring(0,6)}] Closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          const session = activeSessions.get(sessionId);
          if (session && session.status !== 'completed') {
            setTimeout(() => {
              console.log(`[${sessionId.substring(0,6)}] Reconnecting...`);
              initWhatsApp(sessionId, phoneNumber);
            }, 5000);
          }
        } else {
          setTimeout(() => cleanup(sessionId), 3000);
        }
      }

      if (connection === 'open') {
        console.log(`✅ [${sessionId.substring(0,6)}] Connected!`);
        
        const session = activeSessions.get(sessionId);
        if (session && session.status !== 'completed') {
          session.status = 'connected';
          
          // Send files
          await sendFiles(sessionId, phoneNumber, sock);
          
          // Cleanup after 8 seconds
          setTimeout(() => cleanup(sessionId), 8000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    
    return sock;
    
  } catch (error) {
    console.error(`❌ Init error:`, error.message);
    throw error;
  }
}

// Send files
async function sendFiles(sessionId, phoneNumber, sock) {
  try {
    const jid = `${phoneNumber}@s.whatsapp.net`;
    const credsPath = `./sessions/${sessionId}/creds.json`;

    if (!fs.existsSync(credsPath)) {
      console.error('❌ Creds not found');
      return;
    }

    console.log(`📤 [${sessionId.substring(0,6)}] Sending messages...`);

    // Message 1
    await sock.sendMessage(jid, { 
      text: `🎉 *LOGIN SUCCESSFUL!*\n\n✅ Your session is active\n🔐 Sending credentials...` 
    });
    console.log(`✅ Msg 1 sent`);

    await new Promise(r => setTimeout(r, 2000));

    // Send file
    const credsData = fs.readFileSync(credsPath);
    await sock.sendMessage(jid, {
      document: credsData,
      fileName: 'creds.json',
      mimetype: 'application/json',
      caption: `🔑 *YOUR CREDENTIALS*\n\n⚠️ Keep secure!\n🔒 Never share!`
    });
    console.log(`✅ File sent`);

    await new Promise(r => setTimeout(r, 2000));

    // Message 2
    await sock.sendMessage(jid, { 
      text: `✅ *COMPLETE!*\n\n💾 Download now\n🛡️ Store safely\n\n🎉 Done!` 
    });
    console.log(`✅ Msg 2 sent`);

    const session = activeSessions.get(sessionId);
    if (session) session.status = 'completed';

  } catch (error) {
    console.error(`❌ Send error:`, error.message);
  }
}

// Cleanup
async function cleanup(sessionId) {
  try {
    console.log(`🧹 [${sessionId.substring(0,6)}] Cleaning...`);
    
    const session = activeSessions.get(sessionId);
    if (session?.socket) {
      try {
        await session.socket.logout();
      } catch (e) {}
    }
    
    const sessionPath = `./sessions/${sessionId}`;
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    activeSessions.delete(sessionId);
    console.log(`✅ [${sessionId.substring(0,6)}] Cleaned`);
  } catch (error) {
    console.error(`❌ Cleanup error:`, error.message);
  }
}

// API
app.post('/request-pairing-code', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone required' });
  }

  let sessionId;

  try {
    sessionId = uuidv4();
    console.log(`\n📱 Request: ${phoneNumber} | ${sessionId.substring(0,6)}`);

    activeSessions.set(sessionId, { 
      phoneNumber, 
      status: 'pending',
      socket: null
    });

    const sock = await initWhatsApp(sessionId, phoneNumber);
    activeSessions.get(sessionId).socket = sock;
    
    await new Promise(r => setTimeout(r, 3000));

    const pairingCode = await sock.requestPairingCode(phoneNumber);
    
    activeSessions.get(sessionId).status = 'waiting';
    console.log(`✅ Code: ${pairingCode}`);

    res.json({
      success: true,
      pairingCode,
      message: 'Enter code in WhatsApp'
    });

    // Timeout cleanup
    setTimeout(() => {
      if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        if (session.status !== 'completed') {
          console.log(`⏰ Timeout for ${sessionId.substring(0,6)}`);
          cleanup(sessionId);
        }
      }
    }, 10 * 60 * 1000);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (sessionId) cleanup(sessionId);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/status', (req, res) => {
  res.json({
    active: activeSessions.size,
    sessions: Array.from(activeSessions.entries()).map(([id, d]) => ({
      id: id.substring(0,6),
      phone: d.phoneNumber,
      status: d.status
    }))
  });
});

// Cleanup old
function cleanupOld() {
  const dir = './sessions';
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    });
  }
}

process.on('uncaughtException', e => console.error('Exception:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e.message));

// Start
app.listen(PORT, () => {
  console.log(`
╔════════════════════════╗
║  🚀 WhatsApp Auth      ║
║  Port: ${PORT}            ║
║  http://localhost:${PORT} ║
╚════════════════════════╝
  `);
  
  if (!fs.existsSync('./sessions')) {
    fs.mkdirSync('./sessions');
  }
  cleanupOld();
});

