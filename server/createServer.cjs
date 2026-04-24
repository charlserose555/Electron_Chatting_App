const express = require('express');
const http = require('node:http');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const fs = require('node:fs');
const path = require('node:path');

function createLanServer({ port = 4000, userDataPath }) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: true, credentials: true } });

  const dataDir = path.join(userDataPath, 'lan-chat-data');
  const uploadsDir = path.join(dataDir, 'uploads');
  const dbFile = path.join(dataDir, 'db.json');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const CALL_TIMEOUT_MS = 30_000;
  const activeCalls = new Map(); // conversationKey -> { fromUserId, toUserId, timeoutId }

  function loadDb() {
    if (!fs.existsSync(dbFile)) {
      const initial = { users: [], messages: [] };
      fs.writeFileSync(dbFile, JSON.stringify(initial, null, 2));
      return initial;
    }

    try {
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch {
      return { users: [], messages: [] };
    }
  }

  let db = loadDb();

  function saveDb() {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  }

  function safeName(name) {
    return String(name || '').trim().slice(0, 60);
  }

  function getUserById(userId) {
    return db.users.find((u) => u.id === userId) || null;
  }

  function getUserByName(name) {
    const normalized = safeName(name).toLowerCase();
    return db.users.find((u) => u.name.toLowerCase() === normalized) || null;
  }

  function upsertUser(name) {
    const existing = getUserByName(name);
    if (existing) return existing;

    const user = {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: safeName(name),
      createdAt: Date.now()
    };

    db.users.push(user);
    saveDb();
    return user;
  }

  function conversationKey(a, b) {
    return [a, b].sort().join('__');
  }

  function getMessages(userA, userB) {
    const key = conversationKey(userA, userB);
    return db.messages.filter((m) => m.conversationKey === key).sort((a, b) => a.createdAt - b.createdAt);
  }

  function findMessageById(messageId) {
    return db.messages.find((m) => m.id === messageId) || null;
  }

  function serializeMessage(message) {
    return {
      id: message.id,
      conversationKey: message.conversationKey,
      fromUserId: message.fromUserId,
      toUserId: message.toUserId,
      text: message.text,
      attachment: message.attachment || null,
      type: message.type || (message.attachment ? 'file' : 'text'),
      replyTo: message.replyTo || null,
      system: message.system || null,
      call: message.call || null,
      createdAt: message.createdAt,
      deletedAt: message.deletedAt || null,
      deletedByUserId: message.deletedByUserId || null,
      deliveredAt: message.deliveredAt || null,
      readAt: message.readAt || null
    };
  }

  function addMessage({
    fromUserId,
    toUserId,
    text = '',
    attachment = null,
    type = null,
    replyTo = null,
    system = null,
    call = null
  }) {
    const message = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationKey: conversationKey(fromUserId, toUserId),
      fromUserId,
      toUserId,
      text,
      attachment,
      type: type || (attachment ? 'file' : 'text'),
      replyTo,
      system,
      call,
      createdAt: Date.now(),
      deletedAt: null,
      deletedByUserId: null,
      deliveredAt: null,
      readAt: null
    };

    db.messages.push(message);
    saveDb();
    return message;
  }

  function addSystemMessage({ fromUserId, toUserId, kind, text = '', meta = null }) {
    return addMessage({
      fromUserId,
      toUserId,
      type: 'system',
      text: '',
      attachment: null,
      system: {
        kind,
        text,
        meta
      }
    });
  }

  function addCallHistory({ fromUserId, toUserId, status }) {
    return addMessage({
      fromUserId,
      toUserId,
      type: 'call',
      text: '',
      attachment: null,
      call: {
        status,
        createdAt: Date.now()
      }
    });
  }

  function deleteMessage({ messageId, byUserId }) {
    const message = findMessageById(messageId);
    if (!message) return { ok: false, error: 'Message not found' };
    if (message.fromUserId !== byUserId) return { ok: false, error: 'Only the sender can delete this message' };

    message.text = '';
    message.attachment = null;
    message.type = 'deleted';
    message.call = null;
    message.deletedAt = Date.now();
    message.deletedByUserId = byUserId;
    saveDb();

    return { ok: true, message };
  }

  function buildReplyToSnapshot(original) {
    if (!original) return null;

    return {
      messageId: original.id,
      fromUserId: original.fromUserId,
      text: original.type === 'deleted' ? 'Message deleted' : original.text || '',
      attachmentName: original.attachment?.filename || null,
      isImage: !!original.attachment?.isImage
    };
  }

  function resolveReplyTo(replyToMessageId, fromUserId, toUserId) {
    if (!replyToMessageId) return null;

    const original = findMessageById(replyToMessageId);
    if (!original) return null;

    if (original.conversationKey !== conversationKey(fromUserId, toUserId)) {
      return null;
    }

    if (['call', 'system'].includes(original.type)) {
      return null;
    }

    return buildReplyToSnapshot(original);
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const safeExt = path.extname(file.originalname || '').slice(0, 10);
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt}`);
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
  });

  const onlineSockets = new Map(); // userId -> socket.id

  function emitUsersChanged() {
    io.emit('users:changed');
  }

  function emitPresence() {
    io.emit('presence:update', [...onlineSockets.keys()]);
  }

  function emitMessageToParticipants(message) {
    const payload = serializeMessage(message);
    const senderSocketId = onlineSockets.get(message.fromUserId);
    const receiverSocketId = onlineSockets.get(message.toUserId);

    if (senderSocketId) io.to(senderSocketId).emit('message:new', payload);
    if (receiverSocketId) io.to(receiverSocketId).emit('message:new', payload);
  }

  function emitMessageStatus(message) {
    const payload = {
      messageId: message.id,
      deliveredAt: message.deliveredAt || null,
      readAt: message.readAt || null
    };

    const senderSocketId = onlineSockets.get(message.fromUserId);
    const recipientSocketId = onlineSockets.get(message.toUserId);

    if (senderSocketId) io.to(senderSocketId).emit('message:status', payload);
    if (recipientSocketId) io.to(recipientSocketId).emit('message:status', payload);
  }

  function clearActiveCall(key) {
    const active = activeCalls.get(key);
    if (active) {
      clearTimeout(active.timeoutId);
      activeCalls.delete(key);
    }
    return active || null;
  }

  function emitCallEndedToParticipants(fromUserId, toUserId) {
    const callerSocketId = onlineSockets.get(fromUserId);
    const calleeSocketId = onlineSockets.get(toUserId);

    if (callerSocketId) io.to(callerSocketId).emit('call:ended', { fromUserId: toUserId });
    if (calleeSocketId) io.to(calleeSocketId).emit('call:ended', { fromUserId });
  }

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(uploadsDir));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, port, userCount: db.users.length });
  });

  app.post('/api/login', (req, res) => {
    const name = safeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const user = upsertUser(name);
    emitUsersChanged();

    res.json({ user, users: db.users });
  });

  app.get('/api/users', (_req, res) => {
    res.json({ users: db.users, onlineUserIds: [...onlineSockets.keys()] });
  });

  app.get('/api/roster', (_req, res) => {
    res.json({ users: db.users, onlineUserIds: [...onlineSockets.keys()] });
  });

  app.get('/api/messages/:me/:peer', (req, res) => {
    const { me, peer } = req.params;
    res.json({ messages: getMessages(me, peer).map(serializeMessage) });
  });

  app.post('/api/upload', upload.single('file'), (req, res) => {
    const fromUserId = String(req.body?.fromUserId || '');
    const toUserId = String(req.body?.toUserId || '');
    const text = String(req.body?.text || '');
    const replyToMessageId = String(req.body?.replyToMessageId || '');
    const sender = getUserById(fromUserId);
    const receiver = getUserById(toUserId);

    if (!sender || !receiver || !req.file) {
      return res.status(400).json({ error: 'Invalid upload request' });
    }

    const attachment = {
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url: `/uploads/${req.file.filename}`,
      isImage: /^image\//.test(req.file.mimetype)
    };

    const replyTo = resolveReplyTo(replyToMessageId, fromUserId, toUserId);

    const message = addMessage({
      fromUserId,
      toUserId,
      text,
      attachment,
      replyTo
    });
    emitMessageToParticipants(message);

    const systemNotice = addSystemMessage({
      fromUserId,
      toUserId,
      kind: 'file_upload',
      meta: {
        actorUserId: fromUserId,
        filename: attachment.filename,
        isImage: attachment.isImage
      }
    });
    emitMessageToParticipants(systemNotice);

    res.json({
      message: serializeMessage(message),
      systemNotice: serializeMessage(systemNotice)
    });
  });

  io.on('connection', (socket) => {
    socket.on('auth:join', ({ userId }) => {
      const user = getUserById(userId);
      if (!user) return;

      socket.data.userId = userId;
      onlineSockets.set(userId, socket.id);
      emitPresence();
    });

    socket.on('users:sync', (callback) => {
      callback?.({ users: db.users, onlineUserIds: [...onlineSockets.keys()] });
    });

    socket.on('message:send', ({ fromUserId, toUserId, text, replyToMessageId }, callback) => {
      const sender = getUserById(fromUserId);
      const receiver = getUserById(toUserId);
      const clean = String(text || '').trim();

      if (!sender || !receiver || !clean) {
        callback?.({ ok: false, error: 'Invalid message' });
        return;
      }

      const replyTo = resolveReplyTo(replyToMessageId, fromUserId, toUserId);

      const message = addMessage({
        fromUserId,
        toUserId,
        text: clean,
        replyTo
      });

      emitMessageToParticipants(message);
      callback?.({ ok: true, message: serializeMessage(message) });
    });

    socket.on('message:delete', ({ messageId, byUserId }, callback) => {
      const result = deleteMessage({ messageId, byUserId });
      if (!result.ok) {
        callback?.(result);
        return;
      }

      const payload = serializeMessage(result.message);
      const peerId = payload.fromUserId === byUserId ? payload.toUserId : payload.fromUserId;
      const peerSocketId = onlineSockets.get(peerId);

      if (peerSocketId) io.to(peerSocketId).emit('message:deleted', payload);
      io.to(socket.id).emit('message:deleted', payload);

      callback?.({ ok: true, message: payload });
    });

    socket.on('message:delivered', ({ messageId, byUserId }) => {
      const message = findMessageById(messageId);
      if (!message) return;
      if (message.toUserId !== byUserId) return;
      if (message.type === 'deleted') return;

      if (!message.deliveredAt) {
        message.deliveredAt = Date.now();
        saveDb();
      }

      emitMessageStatus(message);
    });

    socket.on('message:read', ({ messageId, byUserId }) => {
      const message = findMessageById(messageId);
      if (!message) return;
      if (message.toUserId !== byUserId) return;
      if (message.type === 'deleted') return;

      if (!message.deliveredAt) {
        message.deliveredAt = Date.now();
      }

      if (!message.readAt) {
        message.readAt = Date.now();
      }

      saveDb();
      emitMessageStatus(message);
    });

    socket.on('typing:set', ({ fromUserId, toUserId, isTyping }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('typing:update', {
          fromUserId,
          isTyping: !!isTyping
        });
      }
    });

    socket.on('call:invite', ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);

      clearActiveCall(key);

      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'incoming'
      });
      emitMessageToParticipants(history);

      const timeoutId = setTimeout(() => {
        const current = activeCalls.get(key);
        if (!current) return;

        activeCalls.delete(key);

        const unanswered = addCallHistory({
          fromUserId,
          toUserId,
          status: 'unanswered'
        });
        emitMessageToParticipants(unanswered);
        emitCallEndedToParticipants(fromUserId, toUserId);
      }, CALL_TIMEOUT_MS);

      activeCalls.set(key, { fromUserId, toUserId, timeoutId });

      if (targetSocketId) io.to(targetSocketId).emit('call:invite', { fromUserId });
    });

    socket.on('call:accept', ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);

      clearActiveCall(key);

      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'accepted'
      });
      emitMessageToParticipants(history);

      if (targetSocketId) io.to(targetSocketId).emit('call:accepted', { fromUserId });
    });

    socket.on('call:decline', ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);

      clearActiveCall(key);

      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'declined'
      });
      emitMessageToParticipants(history);

      if (targetSocketId) io.to(targetSocketId).emit('call:declined', { fromUserId });
      emitCallEndedToParticipants(toUserId, fromUserId);
    });

    socket.on('call:end', ({ fromUserId, toUserId }) => {
      const key = conversationKey(fromUserId, toUserId);
      const active = clearActiveCall(key);

      if (active) {
        const unanswered = addCallHistory({
          fromUserId,
          toUserId,
          status: 'unanswered'
        });
        emitMessageToParticipants(unanswered);
      }

      emitCallEndedToParticipants(fromUserId, toUserId);
    });

    socket.on('signal', ({ fromUserId, toUserId, data }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      if (targetSocketId) io.to(targetSocketId).emit('signal', { fromUserId, data });
    });

    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) return;

      if (onlineSockets.get(userId) === socket.id) {
        onlineSockets.delete(userId);
        emitUsersChanged();
        emitPresence();
      }
    });
  });

  return {
    port,
    async start(host = '0.0.0.0') {
      await new Promise((resolve) => server.listen(port, host, resolve));
      return { port };
    },
    async stop() {
      await new Promise((resolve) => io.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

module.exports = { createLanServer };