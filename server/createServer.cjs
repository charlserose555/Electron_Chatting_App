const express = require('express');
const http = require('node:http');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createLanServer({ port = 4000, userDataPath }) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: true, credentials: true } });

  const dataDir = path.join(userDataPath, 'lan-chat-data');
  const uploadsDir = path.join(dataDir, 'uploads');
  const dbFile = path.join(dataDir, 'db.json');

  fs.mkdirSync(uploadsDir, { recursive: true });

  const CALL_TIMEOUT_MS = 30_000;
  const activeCalls = new Map(); // conversationKey -> { fromUserId, toUserId, mode, timeoutId }
  const onlineSockets = new Map(); // userId -> socketId
  const idleUserIds = new Set();
  const activeChatTargets = new Map(); // userId -> selectedPeerUserId | null

  function safeUserId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 32);
  }

  function safeDisplayName(value) {
    return String(value || '').trim().slice(0, 60);
  }

  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  function verifyPassword(password, storedHash) {
    try {
      const [salt, hash] = String(storedHash || '').split(':');
      if (!salt || !hash) return false;

      const derived = crypto.scryptSync(String(password || ''), salt, 64);
      const hashBuffer = Buffer.from(hash, 'hex');

      if (derived.length !== hashBuffer.length) return false;
      return crypto.timingSafeEqual(derived, hashBuffer);
    } catch {
      return false;
    }
  }

  function createId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeUserRecord(raw, index) {
    const fallbackUserId = safeUserId(raw?.userId || raw?.name || raw?.id || `user${index + 1}`) || `user${index + 1}`;
    const hasPasswordHash = typeof raw?.passwordHash === 'string' && raw.passwordHash.includes(':');

    return {
      id: String(raw?.id || createId('u')),
      userId: fallbackUserId,
      name: safeDisplayName(raw?.name || fallbackUserId) || fallbackUserId,
      passwordHash: hasPasswordHash ? raw.passwordHash : hashPassword(fallbackUserId),
      role: raw?.role === 'admin' ? 'admin' : 'user',
      avatarUrl: typeof raw?.avatarUrl === 'string' ? raw.avatarUrl : null,
      isApproved: typeof raw?.isApproved === 'boolean' ? raw.isApproved : true,
      canLogin: typeof raw?.canLogin === 'boolean' ? raw.canLogin : true,
      canAudioCall: typeof raw?.canAudioCall === 'boolean' ? raw.canAudioCall : true,
      canVideoCall: typeof raw?.canVideoCall === 'boolean' ? raw.canVideoCall : true,
      mustChangePassword:
        typeof raw?.mustChangePassword === 'boolean' ? raw.mustChangePassword : !hasPasswordHash,
      createdAt: Number(raw?.createdAt) || Date.now(),
      updatedAt: Number(raw?.updatedAt) || Number(raw?.createdAt) || Date.now()
    };
  }

  function normalizeUsers(rawUsers) {
    const users = Array.isArray(rawUsers) ? rawUsers.map(normalizeUserRecord) : [];
    const usedUserIds = new Set();

    for (const user of users) {
      let candidate = user.userId || `user${users.indexOf(user) + 1}`;
      let suffix = 1;

      while (usedUserIds.has(candidate)) {
        candidate = `${user.userId}-${suffix++}`;
      }

      user.userId = candidate;
      usedUserIds.add(candidate);
    }

    if (users.length && !users.some((user) => user.role === 'admin')) {
      users[0].role = 'admin';
      users[0].isApproved = true;
      users[0].canLogin = true;
    }

    return users;
  }

  function normalizeDbShape(raw) {
    return {
      users: normalizeUsers(raw?.users),
      messages: Array.isArray(raw?.messages) ? raw.messages : [],
      conversationStates: Array.isArray(raw?.conversationStates) ? raw.conversationStates : [],
      messageStates: Array.isArray(raw?.messageStates) ? raw.messageStates : [],
      sessions: Array.isArray(raw?.sessions) ? raw.sessions : []
    };
  }

  function loadDb() {
    if (!fs.existsSync(dbFile)) {
      const initial = {
        users: [],
        messages: [],
        conversationStates: [],
        messageStates: [],
        sessions: []
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
        messageStates: [],
        sessions: []
      };
    }
  }

  let db = loadDb();

  function saveDb() {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  }

  function conversationKey(a, b) {
    return [a, b].sort().join('__');
  }

  function getUserById(userId) {
    return db.users.find((user) => user.id === userId) || null;
  }

  function getUserByLoginId(userId) {
    const normalized = safeUserId(userId);
    return db.users.find((user) => user.userId === normalized) || null;
  }

  function hasAdminUser() {
    return db.users.some((user) => user.role === 'admin');
  }

  function sanitizeUser(user, viewer = null) {
    const isSelf = !!viewer && viewer.id === user.id;
    const isAdmin = !!viewer && viewer.role === 'admin';

    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      avatarUrl: user.avatarUrl || null,
      role: isSelf || isAdmin ? user.role : undefined,
      isApproved: isSelf || isAdmin ? !!user.isApproved : undefined,
      canLogin: isSelf || isAdmin ? !!user.canLogin : undefined,
      canAudioCall: !!user.canAudioCall,
      canVideoCall: !!user.canVideoCall,
      mustChangePassword: isSelf || isAdmin ? !!user.mustChangePassword : undefined,
      createdAt: user.createdAt
    };
  }

  function getVisibleUsersFor(viewer) {
    if (!viewer) return [];

    if (viewer.role === 'admin') {
      return db.users.map((user) => sanitizeUser(user, viewer));
    }

    return db.users
      .filter((user) => user.id === viewer.id || user.isApproved)
      .map((user) => sanitizeUser(user, viewer));
  }

  function createUserAccount({ userId, password, name }) {
    const normalizedUserId = safeUserId(userId);
    const displayName = safeDisplayName(name || normalizedUserId);

    if (!normalizedUserId) {
      return { ok: false, error: 'User ID is required' };
    }

    if (String(password || '').length < 4) {
      return { ok: false, error: 'Password must be at least 4 characters' };
    }

    if (getUserByLoginId(normalizedUserId)) {
      return { ok: false, error: 'User ID already exists' };
    }

    const firstUser = db.users.length === 0 || !hasAdminUser();
    const now = Date.now();

    const user = {
      id: createId('u'),
      userId: normalizedUserId,
      name: displayName || normalizedUserId,
      passwordHash: hashPassword(password),
      role: firstUser ? 'admin' : 'user',
      avatarUrl: null,
      isApproved: firstUser,
      canLogin: firstUser,
      canAudioCall: true,
      canVideoCall: true,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now
    };

    db.users.push(user);
    saveDb();

    return { ok: true, user };
  }

  function createSession(userId) {
    const session = {
      token: crypto.randomBytes(32).toString('hex'),
      userId,
      createdAt: Date.now()
    };

    db.sessions.push(session);
    saveDb();
    return session;
  }

  function getSession(token) {
    return db.sessions.find((item) => item.token === token) || null;
  }

  function deleteSession(token) {
    db.sessions = db.sessions.filter((item) => item.token !== token);
    saveDb();
  }

  function deleteUserSessions(userId) {
    db.sessions = db.sessions.filter((item) => item.userId !== userId);
    saveDb();
  }

  function getTokenFromReq(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return '';
    return header.slice(7).trim();
  }

  function requireAuth(req, res, next) {
    const token = getTokenFromReq(req);
    const session = getSession(token);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = getUserById(session.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!user.isApproved || !user.canLogin) {
      deleteSession(token);
      return res.status(403).json({ error: 'Your account is not allowed to login' });
    }

    req.authToken = token;
    req.user = user;
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    next();
  }

  function serializeAuthPayload(user) {
    return {
      user: sanitizeUser(user, user),
      users: getVisibleUsersFor(user),
      ...getPresencePayload(),
      ...getActiveChatTargetsPayload()
    };
  }

  function getPresencePayload() {
    const onlineUserIds = [...onlineSockets.keys()];
    const onlineUserIdSet = new Set(onlineUserIds);

    return {
      onlineUserIds,
      idleUserIds: [...idleUserIds].filter((userId) => onlineUserIdSet.has(userId))
    };
  }

  function getActiveChatTargetsPayload() {
    const result = {};
  
    for (const [userId, selectedPeerUserId] of activeChatTargets.entries()) {
      result[userId] = selectedPeerUserId || null;
    }
  
    return {
      activeChatTargets: result
    };
  }
  
  function emitActiveChatTargets() {
    io.emit('chat:active-map', getActiveChatTargetsPayload());
  }
  
  function setActiveChatTarget(userId, selectedPeerUserId, isWindowActive = true) {
    if (!userId) return;
  
    const nextPeerUserId = isWindowActive ? String(selectedPeerUserId || '') : '';
    const nextValue =
      nextPeerUserId &&
      nextPeerUserId !== userId &&
      getUserById(nextPeerUserId)
        ? nextPeerUserId
        : null;
  
    if (activeChatTargets.get(userId) === nextValue) return;
  
    activeChatTargets.set(userId, nextValue);
    emitActiveChatTargets();
  }
  
  function clearActiveChatTarget(userId) {
    if (!userId) return;
    if (!activeChatTargets.has(userId)) return;
  
    activeChatTargets.delete(userId);
    emitActiveChatTargets();
  }

  function findMessageById(messageId) {
    return db.messages.find((message) => message.id === messageId) || null;
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
      id: createId('cs'),
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
      id: createId('ms'),
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
      .filter((message) => message.conversationKey === key)
      .filter((message) => message.createdAt > clearedAt)
      .filter((message) => !isMessageHiddenForUser(viewerUserId, message.id))
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
      type:
        message.type ||
        (attachments.length > 1
          ? 'gallery'
          : message.attachment
          ? 'file'
          : 'text'),
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
      id: createId('m'),
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
    if (message.fromUserId !== byUserId) {
      return { ok: false, error: 'Only the sender can delete this message' };
    }

    message.text = '';
    message.attachment = null;
    message.attachments = null;
    message.type = 'deleted';
    message.call = null;
    message.system = null;
    message.deletedAt = Date.now();
    message.deletedByUserId = byUserId;

    saveDb();

    return { ok: true, message };
  }

  function normalizeCallMode(mode) {
    return mode === 'audio' ? 'audio' : 'video';
  }

  function getAttachmentsFromMessage(message) {
    if (Array.isArray(message.attachments) && message.attachments.length) {
      return message.attachments;
    }

    if (message.attachment) {
      return [message.attachment];
    }

    return [];
  }

  function buildReplyToSnapshot(original) {
    if (!original) return null;

    const attachments = getAttachmentsFromMessage(original);

    return {
      messageId: original.id,
      fromUserId: original.fromUserId,
      text: original.type === 'deleted' ? 'Message deleted' : original.text || '',
      attachmentName: attachments[0]?.filename || null,
      isImage: attachments.length > 0 && attachments.every((item) => item.isImage)
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
    const deletedMessages = db.messages.filter((message) => message.conversationKey === key);
    const deletedMessageIds = new Set(deletedMessages.map((message) => message.id));

    db.messages = db.messages.filter((message) => message.conversationKey !== key);
    db.conversationStates = db.conversationStates.filter((state) => state.conversationKey !== key);
    db.messageStates = db.messageStates.filter((state) => !deletedMessageIds.has(state.messageId));

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

  function clearActiveCall(key) {
    const active = activeCalls.get(key);

    if (active) {
      clearTimeout(active.timeoutId);
      activeCalls.delete(key);
    }

    return active || null;
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

  function emitConversationDeleted({ conversationKey: key, byUserId, peerUserId }) {
    const payload = { conversationKey: key, byUserId, peerUserId };
    const mySocketId = onlineSockets.get(byUserId);
    const peerSocketId = onlineSockets.get(peerUserId);

    if (mySocketId) io.to(mySocketId).emit('conversation:deleted', payload);
    if (peerSocketId) io.to(peerSocketId).emit('conversation:deleted', payload);
  }

  function emitConversationClearedForMe({ conversationKey: key, userId, peerUserId, clearedAt }) {
    const payload = { conversationKey: key, userId, peerUserId, clearedAt };
    const socketId = onlineSockets.get(userId);

    if (socketId) {
      io.to(socketId).emit('conversation:cleared-for-me', payload);
    }
  }

  function emitMessageClearedForMe({ messageId, conversationKey: key, userId, hiddenAt }) {
    const payload = { messageId, conversationKey: key, userId, hiddenAt };
    const socketId = onlineSockets.get(userId);

    if (socketId) {
      io.to(socketId).emit('message:cleared-for-me', payload);
    }
  }

  function emitCallEndedToParticipants(fromUserId, toUserId) {
    const callerSocketId = onlineSockets.get(fromUserId);
    const calleeSocketId = onlineSockets.get(toUserId);

    if (callerSocketId) {
      io.to(callerSocketId).emit('call:ended', { fromUserId: toUserId });
    }

    if (calleeSocketId) {
      io.to(calleeSocketId).emit('call:ended', { fromUserId });
    }
  }

  function revokeUserAccess(targetUserId, reason = 'Your login permission was removed by admin') {
    deleteUserSessions(targetUserId);

    const socketId = onlineSockets.get(targetUserId);
    if (!socketId) return;

    io.to(socketId).emit('auth:revoked', { reason });

    const socket = io.sockets.sockets.get(socketId);
    socket?.disconnect(true);

    onlineSockets.delete(targetUserId);
    idleUserIds.delete(targetUserId);
    clearActiveChatTarget(targetUserId);
    emitPresence();
  }

  function ensureCanCall({ caller, callee, mode }) {
    if (!caller || !callee) {
      return { ok: false, error: 'Invalid users' };
    }

    if (mode === 'audio') {
      if (!caller.canAudioCall || !callee.canAudioCall) {
        return { ok: false, error: 'Audio call is not allowed for this user' };
      }
    }

    if (mode === 'video') {
      if (!caller.canVideoCall || !callee.canVideoCall) {
        return { ok: false, error: 'Video call is not allowed for this user' };
      }
    }

    return { ok: true };
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

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(uploadsDir));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      port,
      userCount: db.users.length
    });
  });

  app.post('/api/register', (req, res) => {
    const userId = safeUserId(req.body?.userId);
    const password = String(req.body?.password || '');

    const result = createUserAccount({
      userId,
      password,
      name: userId
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    emitUsersChanged();

    const isAdmin = result.user.role === 'admin';

    res.json({
      ok: true,
      message: isAdmin
        ? 'Admin account created. You can log in now.'
        : 'Registration submitted. Please wait for admin approval.',
      requiresApproval: !isAdmin
    });
  });

  app.post('/api/login', (req, res) => {
    const userId = safeUserId(req.body?.userId);
    const password = String(req.body?.password || '');

    const user = getUserByLoginId(userId);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(400).json({ error: 'Invalid user ID or password' });
    }

    if (!user.isApproved) {
      return res.status(403).json({ error: 'Your account is waiting for admin approval' });
    }

    if (!user.canLogin) {
      return res.status(403).json({ error: 'Your login permission is disabled by admin' });
    }

    const session = createSession(user.id);

    res.json({
      ok: true,
      token: session.token,
      ...serializeAuthPayload(user)
    });
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    deleteSession(req.authToken);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      ok: true,
      ...serializeAuthPayload(req.user)
    });
  });

  app.get('/api/users', requireAuth, (req, res) => {
    res.json({
      users: getVisibleUsersFor(req.user),
      ...getPresencePayload()
    });
  });

  app.get('/api/roster', requireAuth, (req, res) => {
    res.json({
      users: getVisibleUsersFor(req.user),
      ...getPresencePayload()
    });
  });

  app.patch('/api/profile', requireAuth, (req, res) => {
    const nextUserId = req.body?.userId != null ? safeUserId(req.body.userId) : null;
    const nextName = req.body?.name != null ? safeDisplayName(req.body.name) : null;

    if (nextUserId !== null) {
      if (!nextUserId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      const existing = getUserByLoginId(nextUserId);
      if (existing && existing.id !== req.user.id) {
        return res.status(400).json({ error: 'User ID already exists' });
      }

      req.user.userId = nextUserId;
    }

    if (nextName !== null) {
      if (!nextName) {
        return res.status(400).json({ error: 'Display name is required' });
      }

      req.user.name = nextName;
    }

    req.user.updatedAt = Date.now();
    saveDb();
    emitUsersChanged();

    res.json({
      ok: true,
      user: sanitizeUser(req.user, req.user)
    });
  });

  app.post('/api/profile/password', requireAuth, (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!verifyPassword(currentPassword, req.user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }

    req.user.passwordHash = hashPassword(newPassword);
    req.user.mustChangePassword = false;
    req.user.updatedAt = Date.now();

    saveDb();

    res.json({ ok: true });
  });

  app.post('/api/profile/avatar', requireAuth, upload.single('avatar'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Avatar file is required' });
    }

    if (!/^image\//.test(req.file.mimetype)) {
      return res.status(400).json({ error: 'Avatar must be an image' });
    }

    req.user.avatarUrl = `/uploads/${req.file.filename}`;
    req.user.updatedAt = Date.now();

    saveDb();
    emitUsersChanged();

    res.json({
      ok: true,
      user: sanitizeUser(req.user, req.user)
    });
  });

  app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json({
      ok: true,
      users: db.users.map((user) => sanitizeUser(user, req.user))
    });
  });

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const target = getUserById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.role === 'admin' && target.id !== req.user.id) {
      return res.status(400).json({ error: 'Cannot modify another admin here' });
    }

    const updates = req.body || {};

    if (target.id === req.user.id && req.user.role === 'admin') {
      if (updates.isApproved === false || updates.canLogin === false) {
        return res.status(400).json({ error: 'Admin cannot disable their own login access' });
      }
    }

    if (typeof updates.isApproved === 'boolean') {
      target.isApproved = updates.isApproved;
    }

    if (typeof updates.canLogin === 'boolean') {
      target.canLogin = updates.canLogin;
    }

    if (typeof updates.canAudioCall === 'boolean') {
      target.canAudioCall = updates.canAudioCall;
    }

    if (typeof updates.canVideoCall === 'boolean') {
      target.canVideoCall = updates.canVideoCall;
    }

    target.updatedAt = Date.now();
    saveDb();

    if (!target.isApproved || !target.canLogin) {
      revokeUserAccess(target.id, 'Your login permission was removed by admin');
    }

    emitUsersChanged();

    res.json({
      ok: true,
      user: sanitizeUser(target, req.user)
    });
  });

  app.get('/api/messages/:me/:peer', requireAuth, (req, res) => {
    const { me, peer } = req.params;

    if (req.user.id !== me) {
      return res.status(403).json({ error: 'Unauthorized conversation access' });
    }

    res.json({
      messages: getMessages(me, peer, me).map(serializeMessage)
    });
  });

  app.post('/api/upload', requireAuth, upload.any(), (req, res) => {
    const fromUserId = req.user.id;
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

    if (attachments.length > 1 && !attachments.every((item) => item.isImage)) {
      return res.status(400).json({
        error: 'Only multiple images can be sent as one gallery message'
      });
    }

    const replyTo = resolveReplyTo(replyToMessageId, fromUserId, toUserId);

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
    socket.on('auth:join', ({ token }, callback) => {
      const session = getSession(String(token || ''));
      if (!session) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }
    
      const user = getUserById(session.userId);
      if (!user || !user.isApproved || !user.canLogin) {
        callback?.({ ok: false, error: 'Login is not allowed' });
        return;
      }
    
      socket.data.userId = user.id;
      socket.data.authToken = token;
    
      onlineSockets.set(user.id, socket.id);
      idleUserIds.delete(user.id);
      activeChatTargets.set(user.id, null);
    
      emitPresence();
      emitActiveChatTargets();
    
      // Tell other already-connected clients to refresh their user list
      socket.broadcast.emit('users:changed');
    
      callback?.({
        ok: true,
        ...serializeAuthPayload(user)
      });
    });

    socket.on('users:sync', (callback) => {
      const userId = socket.data.userId;
      const user = getUserById(userId);

      callback?.({
        ok: !!user,
        users: user ? getVisibleUsersFor(user) : [],
        ...getPresencePayload(),
        ...getActiveChatTargetsPayload()
      });
    });

    socket.on('chat:selected-peer', ({ selectedPeerUserId, isWindowActive }, callback) => {
      const userId = socket.data.userId;
      if (!userId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

      setActiveChatTarget(userId, selectedPeerUserId, isWindowActive !== false);
      callback?.({ ok: true });
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

    socket.on('conversation:clear-for-me', ({ peerUserId }, callback) => {
      const userId = socket.data.userId;
      if (!userId) {
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

    socket.on('conversation:delete', ({ peerUserId }, callback) => {
      const userId = socket.data.userId;
      if (!userId) {
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

    socket.on('message:clear-for-me', ({ messageId }, callback) => {
      const userId = socket.data.userId;
      if (!userId) {
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

    socket.on('message:send', ({ toUserId, text, replyToMessageId }, callback) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

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

    socket.on('message:delete', ({ messageId }, callback) => {
      const byUserId = socket.data.userId;
      if (!byUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

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

    socket.on('message:delivered', ({ messageId }) => {
      const byUserId = socket.data.userId;
      if (!byUserId) return;

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

    socket.on('message:read', ({ messageId }) => {
      const byUserId = socket.data.userId;
      if (!byUserId) return;

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

    socket.on('typing:set', ({ toUserId, isTyping }) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) return;

      const targetSocketId = onlineSockets.get(toUserId);
      if (!targetSocketId) return;

      io.to(targetSocketId).emit('typing:update', {
        fromUserId,
        isTyping: !!isTyping
      });
    });

    socket.on('call:invite', ({ toUserId, mode }, callback) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

      const caller = getUserById(fromUserId);
      const callee = getUserById(toUserId);
      const callMode = normalizeCallMode(mode);
      const permission = ensureCanCall({ caller, callee, mode: callMode });

      if (!permission.ok) {
        callback?.(permission);
        return;
      }

      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);

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

      activeCalls.set(key, {
        fromUserId,
        toUserId,
        mode: callMode,
        timeoutId
      });

      if (targetSocketId) {
        io.to(targetSocketId).emit('call:invite', { fromUserId, mode: callMode });
      }

      callback?.({ ok: true });
    });

    socket.on('call:accept', ({ toUserId }, callback) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

      const targetSocketId = onlineSockets.get(toUserId);
      const key = conversationKey(fromUserId, toUserId);
      const active = clearActiveCall(key);
      const callMode = active?.mode || 'video';

      const caller = getUserById(toUserId);
      const callee = getUserById(fromUserId);
      const permission = ensureCanCall({ caller, callee, mode: callMode });

      if (!permission.ok) {
        callback?.(permission);
        return;
      }

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

      callback?.({ ok: true });
    });

    socket.on('call:decline', ({ toUserId }, callback) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

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
      callback?.({ ok: true });
    });

    socket.on('call:end', ({ toUserId }, callback) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) {
        callback?.({ ok: false, error: 'Unauthorized' });
        return;
      }

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
      callback?.({ ok: true });
    });

    socket.on('signal', ({ toUserId, data }) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) return;

      const targetSocketId = onlineSockets.get(toUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('signal', { fromUserId, data });
      }
    });

    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) return;

      if (onlineSockets.get(userId) === socket.id) {
        onlineSockets.delete(userId);
        idleUserIds.delete(userId);
        clearActiveChatTarget(userId);
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