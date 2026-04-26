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

  function normalizeDbShape(raw) {
    return {
      users: Array.isArray(raw?.users) ? raw.users : [],
      messages: Array.isArray(raw?.messages) ? raw.messages : [],
      conversationStates: Array.isArray(raw?.conversationStates) ? raw.conversationStates : [],
      messageStates: Array.isArray(raw?.messageStates) ? raw.messageStates : []
    };
  }

  function loadDb() {
    if (!fs.existsSync(dbFile)) {
      const initial = {
        users: [],
        messages: [],
        conversationStates: [],
        messageStates: []
      };
      fs.writeFileSync(dbFile, JSON.stringify(initial, null, 2));
      return initial;
    }

    try {
      return normalizeDbShape(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
    } catch {
      return {
        users: [],
        messages: [],
        conversationStates: [],
        messageStates: []
      };
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

  function findMessageById(messageId) {
    return db.messages.find((m) => m.id === messageId) || null;
  }

  function getConversationState(userId, peerUserId) {
    const key = conversationKey(userId, peerUserId);
    return (
      db.conversationStates.find(
        (item) => item.userId === userId && item.conversationKey === key
      ) || null
    );
  }

  function ensureConversationState(userId, peerUserId) {
    const existing = getConversationState(userId, peerUserId);
    if (existing) return existing;

    const state = {
      id: `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      peerUserId,
      conversationKey: conversationKey(userId, peerUserId),
      clearedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.conversationStates.push(state);
    return state;
  }

  function getConversationClearedAt(userId, peerUserId) {
    const state = getConversationState(userId, peerUserId);
    return state?.clearedAt || 0;
  }

  function getMessageState(userId, messageId) {
    return (
      db.messageStates.find(
        (item) => item.userId === userId && item.messageId === messageId
      ) || null
    );
  }
  
  function ensureMessageState(userId, messageId) {
    const existing = getMessageState(userId, messageId);
    if (existing) return existing;
  
    const state = {
      id: `ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      messageId,
      hiddenAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  
    db.messageStates.push(state);
    return state;
  }
  
  function isMessageHiddenForUser(userId, messageId) {
    const state = getMessageState(userId, messageId);
    return !!state?.hiddenAt;
  }
  
  function clearMessageForUser({ userId, messageId }) {
    const message = findMessageById(messageId);
    if (!message) return { ok: false, error: 'Message not found' };
  
    if (message.fromUserId !== userId && message.toUserId !== userId) {
      return { ok: false, error: 'You are not allowed to delete this message for yourself' };
    }
  
    const now = Date.now();
    const state = ensureMessageState(userId, messageId);
  
    state.hiddenAt = now;
    state.updatedAt = now;
  
    saveDb();
  
    return {
      ok: true,
      userId,
      messageId,
      conversationKey: message.conversationKey,
      hiddenAt: now
    };
  }

  function clearConversationForUser({ userId, peerUserId }) {
    const me = getUserById(userId);
    const peer = getUserById(peerUserId);

    if (!me || !peer) {
      return { ok: false, error: 'Conversation users not found' };
    }

    const now = Date.now();
    const state = ensureConversationState(userId, peerUserId);

    state.peerUserId = peerUserId;
    state.clearedAt = now;
    state.updatedAt = now;

    saveDb();

    return {
      ok: true,
      userId,
      peerUserId,
      conversationKey: conversationKey(userId, peerUserId),
      clearedAt: now
    };
  }

  function getMessages(userA, userB, viewerUserId = userA) {
    const key = conversationKey(userA, userB);
    const peerUserId = viewerUserId === userA ? userB : userA;
    const clearedAt = getConversationClearedAt(viewerUserId, peerUserId);
  
    return db.messages
      .filter((m) => m.conversationKey === key)
      .filter((m) => m.createdAt > clearedAt)
      .filter((m) => !isMessageHiddenForUser(viewerUserId, m.id))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function serializeMessage(message) {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : message.attachment
      ? [message.attachment]
      : [];
  
    return {
      id: message.id,
      conversationKey: message.conversationKey,
      fromUserId: message.fromUserId,
      toUserId: message.toUserId,
      text: message.text,
      attachment: attachments[0] || null,
      attachments: attachments.length ? attachments : null,
      type: message.type || (attachments.length > 1 ? 'gallery' : message.attachment ? 'file' : 'text'),
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
    attachments = null,
    type = null,
    replyTo = null,
    system = null,
    call = null
  }) {
    const normalizedAttachments = Array.isArray(attachments) && attachments.length
      ? attachments
      : attachment
      ? [attachment]
      : [];
  
    const messageType =
      type ||
      (normalizedAttachments.length > 1
        ? 'gallery'
        : normalizedAttachments.length === 1
        ? 'file'
        : 'text');
  
    const message = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationKey: conversationKey(fromUserId, toUserId),
      fromUserId,
      toUserId,
      text,
      attachment: normalizedAttachments[0] || null,
      attachments: normalizedAttachments.length ? normalizedAttachments : null,
      type: messageType,
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

  function addCallHistory({ fromUserId, toUserId, status, mode = 'video' }) {
    return addMessage({
      fromUserId,
      toUserId,
      type: 'call',
      text: '',
      attachment: null,
      call: {
        status,
        mode: normalizeCallMode(mode),
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

  function normalizeCallMode(mode) {
    return mode === 'audio' ? 'audio' : 'video';
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

  function deleteConversation({ userId, peerUserId }) {
    const me = getUserById(userId);
    const peer = getUserById(peerUserId);
  
    if (!me || !peer) {
      return { ok: false, error: 'Conversation users not found' };
    }
  
    const key = conversationKey(userId, peerUserId);
    const deletedMessages = db.messages.filter((m) => m.conversationKey === key);
    const deletedMessageIds = new Set(deletedMessages.map((m) => m.id));
  
    db.messages = db.messages.filter((m) => m.conversationKey !== key);
    db.conversationStates = db.conversationStates.filter((s) => s.conversationKey !== key);
    db.messageStates = db.messageStates.filter((s) => !deletedMessageIds.has(s.messageId));
    saveDb();
  
    clearActiveCall(key);
  
    return {
      ok: true,
      conversationKey: key,
      deletedCount: deletedMessages.length,
      byUserId: userId,
      peerUserId
    };
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

  const onlineSockets = new Map();
  const idleUserIds = new Set();

  function getPresencePayload() {
    const onlineUserIds = [...onlineSockets.keys()];
    const onlineUserIdSet = new Set(onlineUserIds);

    return {
      onlineUserIds,
      idleUserIds: [...idleUserIds].filter((userId) => onlineUserIdSet.has(userId))
    };
  }

  function emitUsersChanged() {
    io.emit('users:changed');
  }

  function emitPresence() {
    io.emit('presence:update', getPresencePayload());
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

  function emitConversationDeleted({ conversationKey, byUserId, peerUserId }) {
    const payload = { conversationKey, byUserId, peerUserId };

    const mySocketId = onlineSockets.get(byUserId);
    const peerSocketId = onlineSockets.get(peerUserId);

    if (mySocketId) io.to(mySocketId).emit('conversation:deleted', payload);
    if (peerSocketId) io.to(peerSocketId).emit('conversation:deleted', payload);
  }

  function emitConversationClearedForMe({ conversationKey, userId, peerUserId, clearedAt }) {
    const payload = { conversationKey, userId, peerUserId, clearedAt };
    const mySocketId = onlineSockets.get(userId);

    if (mySocketId) {
      io.to(mySocketId).emit('conversation:cleared-for-me', payload);
    }
  }

  function emitMessageClearedForMe({ messageId, conversationKey, userId, hiddenAt }) {
    const payload = { messageId, conversationKey, userId, hiddenAt };
    const socketId = onlineSockets.get(userId);
  
    if (socketId) {
      io.to(socketId).emit('message:cleared-for-me', payload);
    }
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

    res.json({
      user,
      users: db.users,
      ...getPresencePayload()
    });
  });

  app.get('/api/users', (_req, res) => {
    res.json({
      users: db.users,
      ...getPresencePayload()
    });
  });

  app.get('/api/roster', (_req, res) => {
    res.json({
      users: db.users,
      ...getPresencePayload()
    });
  });

  app.get('/api/messages/:me/:peer', (req, res) => {
    const { me, peer } = req.params;
    res.json({ messages: getMessages(me, peer, me).map(serializeMessage) });
  });

  app.post('/api/upload', upload.any(), (req, res) => {
    const fromUserId = String(req.body?.fromUserId || '');
    const toUserId = String(req.body?.toUserId || '');
    const text = String(req.body?.text || '');
    const replyToMessageId = String(req.body?.replyToMessageId || '');
    const sender = getUserById(fromUserId);
    const receiver = getUserById(toUserId);
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  
    if (!sender || !receiver || !uploadedFiles.length) {
      return res.status(400).json({ error: 'Invalid upload request' });
    }
  
    const attachments = uploadedFiles.map((file) => ({
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `/uploads/${file.filename}`,
      isImage: /^image\//.test(file.mimetype)
    }));
  
    const replyTo = resolveReplyTo(replyToMessageId, fromUserId, toUserId);
  
    if (attachments.length > 1 && !attachments.every((item) => item.isImage)) {
      return res.status(400).json({
        error: 'Only multiple images can be sent as one gallery message'
      });
    }
  
    const message = addMessage({
      fromUserId,
      toUserId,
      text,
      attachment: attachments.length === 1 ? attachments[0] : null,
      attachments: attachments.length > 1 ? attachments : null,
      type: attachments.length > 1 ? 'gallery' : 'file',
      replyTo
    });
  
    emitMessageToParticipants(message);
  
    res.json({
      message: serializeMessage(message)
    });
  });

  io.on('connection', (socket) => {
    socket.on('auth:join', ({ userId }) => {
      const user = getUserById(userId);
      if (!user) return;

      socket.data.userId = userId;
      onlineSockets.set(userId, socket.id);
      idleUserIds.delete(userId);
      emitPresence();
    });

    socket.on('users:sync', (callback) => {
      callback?.({
        users: db.users,
        ...getPresencePayload()
      });
    });

    socket.on('presence:set-state', ({ state }) => {
      const userId = socket.data.userId;
      if (!userId) return;
      if (!onlineSockets.has(userId)) return;

      if (state === 'idle') {
        idleUserIds.add(userId);
      } else {
        idleUserIds.delete(userId);
      }

      emitPresence();
    });

    socket.on('conversation:clear-for-me', ({ userId, peerUserId }, callback) => {
      const joinedUserId = socket.data.userId;
      if (!joinedUserId || joinedUserId !== userId) {
        callback?.({ ok: false, error: 'Unauthorized request' });
        return;
      }

      const result = clearConversationForUser({ userId, peerUserId });
      if (!result.ok) {
        callback?.(result);
        return;
      }

      emitConversationClearedForMe(result);
      callback?.(result);
    });

    socket.on('conversation:delete', ({ userId, peerUserId }, callback) => {
      const joinedUserId = socket.data.userId;
      if (!joinedUserId || joinedUserId !== userId) {
        callback?.({ ok: false, error: 'Unauthorized request' });
        return;
      }

      const result = deleteConversation({ userId, peerUserId });

      if (!result.ok) {
        callback?.(result);
        return;
      }

      emitConversationDeleted(result);
      callback?.(result);
    });

    socket.on('message:clear-for-me', ({ userId, messageId }, callback) => {
      const joinedUserId = socket.data.userId;
      if (!joinedUserId || joinedUserId !== userId) {
        callback?.({ ok: false, error: 'Unauthorized request' });
        return;
      }
    
      const result = clearMessageForUser({ userId, messageId });
      if (!result.ok) {
        callback?.(result);
        return;
      }
    
      emitMessageClearedForMe(result);
      callback?.(result);
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

    socket.on('call:invite', ({ fromUserId, toUserId, mode }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);
      const callMode = normalizeCallMode(mode);
    
      clearActiveCall(key);
    
      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'incoming',
        mode: callMode
      });
      emitMessageToParticipants(history);
    
      const timeoutId = setTimeout(() => {
        const current = activeCalls.get(key);
        if (!current) return;
    
        activeCalls.delete(key);
    
        const unanswered = addCallHistory({
          fromUserId: current.fromUserId,
          toUserId: current.toUserId,
          status: 'unanswered',
          mode: current.mode
        });
        emitMessageToParticipants(unanswered);
        emitCallEndedToParticipants(current.fromUserId, current.toUserId);
      }, CALL_TIMEOUT_MS);
    
      activeCalls.set(key, { fromUserId, toUserId, mode: callMode, timeoutId });
    
      if (targetSocketId) {
        io.to(targetSocketId).emit('call:invite', { fromUserId, mode: callMode });
      }
    });
    
    socket.on('call:accept', ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);
      const active = clearActiveCall(key);
      const callMode = active?.mode || 'video';
    
      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'accepted',
        mode: callMode
      });
      emitMessageToParticipants(history);
    
      if (targetSocketId) {
        io.to(targetSocketId).emit('call:accepted', { fromUserId, mode: callMode });
      }
    });
    
    socket.on('call:decline', ({ fromUserId, toUserId }) => {
      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);
      const active = clearActiveCall(key);
      const callMode = active?.mode || 'video';
    
      const history = addCallHistory({
        fromUserId,
        toUserId,
        status: 'declined',
        mode: callMode
      });
      emitMessageToParticipants(history);
    
      if (targetSocketId) {
        io.to(targetSocketId).emit('call:declined', { fromUserId, mode: callMode });
      }
      emitCallEndedToParticipants(toUserId, fromUserId);
    });
    
    socket.on('call:end', ({ fromUserId, toUserId }) => {
      const key = conversationKey(fromUserId, toUserId);
      const active = clearActiveCall(key);
    
      if (active) {
        const unanswered = addCallHistory({
          fromUserId: active.fromUserId,
          toUserId: active.toUserId,
          status: 'unanswered',
          mode: active.mode
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
        idleUserIds.delete(userId);
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