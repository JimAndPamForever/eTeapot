const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const GOOGLE_DRIVE_FILE_ID = process.env.GOOGLE_DRIVE_FILE_ID || 'YOUR_GOOGLE_DRIVE_FILE_ID_HERE';
const KEY_FILE_PATH = path.join(__dirname, 'service-account.json');

// Google Drive Auth Setup
const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE_PATH,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

const DEFAULT_INITIAL_STATE = {
  currentTurn: 'JimSays',
  pendingMessage: {
    sender: 'JimSays',
    text: 'Jim loves Pam'
  }
};

let state = { ...DEFAULT_INITIAL_STATE };

// 1. Read state directly from Google Drive
async function loadStateFromDrive() {
  try {
    const response = await drive.files.get({
      fileId: GOOGLE_DRIVE_FILE_ID,
      alt: 'media',
    });
    
    if (response.data) {
      state = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      console.log('Successfully loaded state from Google Drive:', state);
    }
  } catch (err) {
    console.error('Could not load state from Google Drive. Using default state:', err.message);
    await saveStateToDrive(); // Initialize file in Drive if missing/empty
  }
}

// 2. Write updated state to Google Drive
async function saveStateToDrive() {
  try {
    await drive.files.update({
      fileId: GOOGLE_DRIVE_FILE_ID,
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(state, null, 2),
      },
    });
    console.log('Successfully saved state to Google Drive');
  } catch (err) {
    console.error('Failed to write state to Google Drive:', err.message);
  }
}

// Express Routes & Static Serving
app.use(express.static(path.join(__dirname, 'public')));

app.get('/PamSays', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/JimSays', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getRoomState(role) {
  const hasUnreadMessage = Boolean(state.pendingMessage && state.pendingMessage.sender !== role);
  const isMyTurnToCompose = !state.pendingMessage && state.currentTurn === role;

  return {
    type: 'STATE_UPDATE',
    isMyTurnToCompose,
    hasUnreadMessage,
    messageText: hasUnreadMessage ? state.pendingMessage.text : null,
  };
}

function broadcastStateChange() {
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.role) {
      client.send(JSON.stringify(getRoomState(client.role)));
    }
  });
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    const data = JSON.parse(raw);

    if (data.type === 'REGISTER') {
      ws.role = data.role;
      ws.send(JSON.stringify(getRoomState(ws.role)));
    }

    if (data.type === 'READ_MESSAGE') {
      if (state.pendingMessage && state.pendingMessage.sender !== ws.role) {
        state.pendingMessage = null; // Delete unread message
        state.currentTurn = ws.role; // Pass turn to reader
        
        await saveStateToDrive();     // Commit change to Drive
        broadcastStateChange();
      }
    }

    if (data.type === 'SEND_MESSAGE') {
      if (ws.role !== state.currentTurn || state.pendingMessage) return;

      state.pendingMessage = { sender: ws.role, text: data.text };
      state.currentTurn = ws.role === 'PamSays' ? 'JimSays' : 'PamSays';
      
      await saveStateToDrive();     // Commit new message to Drive
      broadcastStateChange();
    }
  });
});

const PORT = process.env.PORT || 3000;

// Load Google Drive state before starting web server
loadStateFromDrive().then(() => {
  server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
});