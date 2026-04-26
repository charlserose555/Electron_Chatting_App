import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type User = { id: string; name: string; createdAt?: number };

type Attachment = {
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
};

type ReplyTo = {
  messageId: string;
  fromUserId: string;
  text: string;
  attachmentName: string | null;
  isImage: boolean;
};

type CallMode = 'audio' | 'video';

type Message = {
  id: string;
  conversationKey: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  attachment: Attachment | null;
  attachments: Attachment[] | null;
  type: 'text' | 'file' | 'gallery' | 'deleted' | 'call' | 'system';
  replyTo: ReplyTo | null;
  system: null | {
    kind: 'file_upload' | 'info';
    text: string;
    meta?: {
      actorUserId?: string;
      filename?: string;
      isImage?: boolean;
    };
  };
  call: null | {
    status: 'incoming' | 'accepted' | 'declined' | 'unanswered';
    mode?: CallMode;
    createdAt: number;
  };
  createdAt: number;
  deletedAt: number | null;
  deletedByUserId: string | null;
  deliveredAt: number | null;
  readAt: number | null;
};

type PendingUpload = {
  id: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  previewUrl: string | null;
};

type CallState =
  | {
      peerUserId: string;
      mode: CallMode;
      phase: 'outgoing' | 'incoming' | 'connecting' | 'connected';
      muted: boolean;
      cameraOff: boolean;
    }
  | null;

function getInitials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function conversationKey(a: string, b: string) {
  return [a, b].sort().join('__');
}

function timeLabel(ts?: number | null) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dateDivider(ts: number) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function hashCode(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

function avatarBg(seed: string) {
  const colors = [
    ['#4f8cff', '#7c9dff'],
    ['#23c16b', '#60d394'],
    ['#f59e0b', '#ffd166'],
    ['#ec4899', '#ff77b7'],
    ['#8b5cf6', '#b392ff'],
    ['#14b8a6', '#4dd7c3']
  ];
  const idx = Math.abs(hashCode(seed)) % colors.length;
  const [a, b] = colors[idx];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function callHistoryLabel(message: Message, meId: string, _users: User[]) {
  const status = message.call?.status;
  const modeLabel = message.call?.mode === 'audio' ? 'voice' : 'video';

  if (!status) {
    return `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} call`;
  }

  if (status === 'incoming') {
    return message.fromUserId === meId
      ? `Outgoing ${modeLabel} call`
      : `Incoming ${modeLabel} call`;
  }

  if (status === 'accepted') {
    return `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} call accepted`;
  }

  if (status === 'declined') {
    return message.fromUserId === meId
      ? `Declined ${modeLabel} call`
      : `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} call declined`;
  }

  if (status === 'unanswered') {
    return message.fromUserId === meId
      ? `No answer — ${modeLabel} call`
      : `Missed ${modeLabel} call`;
  }

  return `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} call`;
}

function systemChipClass(message: Message) {
  if (message.type === 'deleted') return 'system-chip deleted';
  if (message.type === 'system') return 'system-chip file-upload';

  if (message.type === 'call') {
    const status = message.call?.status;
    if (status === 'accepted') return 'system-chip call-accepted';
    if (status === 'declined') return 'system-chip call-declined';
    if (status === 'unanswered') return 'system-chip call-missed';
    if (status === 'incoming') return 'system-chip call-started';
  }

  return 'system-chip';
}

function systemChipIcon(message: Message, meId: string) {
  if (message.type === 'deleted') return '🗑';
  if (message.type === 'system') return '📎';

  if (message.type === 'call') {
    const status = message.call?.status;
    const mode = message.call?.mode === 'audio' ? 'audio' : 'video';
    const iAmCaller = message.fromUserId === meId;

    if (status === 'incoming') {
      return mode === 'audio' ? '📞' : '🎥';
    }

    if (status === 'accepted') {
      return mode === 'audio' ? '📞' : '🎥';
    }

    if (status === 'declined') {
      return '❌';
    }

    if (status === 'unanswered') {
      return iAmCaller ? '☎' : '📵';
    }
  }

  return '•';
}

function systemMessageLabel(message: Message, meId: string, users: User[]) {
  if (message.type !== 'system' || !message.system) return 'System message';

  if (message.system.kind === 'file_upload') {
    const actorUserId = message.system.meta?.actorUserId;
    const filename = message.system.meta?.filename || 'a file';
    const isImage = !!message.system.meta?.isImage;

    const actorName = users.find((u) => u.id === actorUserId)?.name || 'Someone';

    if (actorUserId === meId) {
      return isImage ? 'You sent an image' : `You sent ${filename}`;
    }

    return isImage ? `${actorName} sent an image` : `${actorName} sent ${filename}`;
  }

  return message.system.text || 'System message';
}

function getMessageAttachments(message: Message) {
  if (Array.isArray(message.attachments) && message.attachments.length) {
    return message.attachments;
  }

  if (message.attachment) {
    return [message.attachment];
  }

  return [];
}
  
function isGalleryMessage(message: Message) {
  const attachments = getMessageAttachments(message);
  return (
    message.type === 'gallery' ||
    (attachments.length > 1 && attachments.every((item) => item.isImage))
  );
}

function previewText(message: Message | undefined, meId: string, users: User[]) {
  if (!message) return 'No messages yet';
  if (message.type === 'deleted') return 'Message deleted';

  if (message.type === 'call') return callHistoryLabel(message, meId, users);
  if (message.type === 'system') return systemMessageLabel(message, meId, users);

  const attachments = getMessageAttachments(message);

  if (isGalleryMessage(message)) {
    return message.text
      ? `🖼 ${attachments.length} photos · ${message.text}`
      : `🖼 ${attachments.length} photos`;
  }

  if (attachments.length === 1) {
    return attachments[0].isImage ? 'Sent an image' : `Sent ${attachments[0].filename}`;
  }

  return message.text;
}

function isRenderableMessage(msg?: Message) {
  return !!msg && !['call', 'deleted', 'system'].includes(msg.type);
}

function AttachmentPreview({
  attachment,
  serverUrl
}: {
  attachment: Attachment;
  serverUrl: string;
}) {
  const href = `${serverUrl}${attachment.url}`;

  if (attachment.isImage) {
    return (
      <img
        className="image-attachment"
        src={href}
        alt={attachment.filename}
        onLoad={() => {
          requestAnimationFrame(() => {
            const el = document.querySelector('.messages') as HTMLElement | null;
            if (el) {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }
          });
        }}
      />
    );
  }

  return (
    <a className="file-attachment" href={href} target="_blank" rel="noreferrer">
      📄 {attachment.filename}
    </a>
  );
}

function GalleryPreview({
  attachments,
  serverUrl
}: {
  attachments: Attachment[];
  serverUrl: string;
}) {
  const visible = attachments.slice(0, 4);
  const extraCount = attachments.length - visible.length;

  return (
    <div
      className={`gallery-attachment grid-${Math.min(visible.length, 4)}`}
    >
      {visible.map((item, index) => {
        const href = `${serverUrl}${item.url}`;
        const showOverlay = index === visible.length - 1 && extraCount > 0;

        return (
          <a
            key={`${item.url}_${index}`}
            className="gallery-item"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            <img src={href} alt={item.filename} className="gallery-item-image" />
            {showOverlay ? (
              <div className="gallery-more-overlay">+{extraCount}</div>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

const storedUser = localStorage.getItem('lan_chat_user_name') || '';
const storedServer = localStorage.getItem('lan_chat_server_url') || '';
const storedHost = localStorage.getItem('lan_chat_host_mode') === '1';

export default function App() {
  const [appInfo, setAppInfo] = useState<{ platform: string; appVersion: string } | null>(null);
  const [hostMode, setHostMode] = useState(storedHost);
  const [hostPort, setHostPort] = useState(4000);
  const [hostAddresses, setHostAddresses] = useState<string[]>([]);
  const [serverUrlInput, setServerUrlInput] = useState(storedServer || 'http://127.0.0.1:4000');
  const [connectedServerUrl, setConnectedServerUrl] = useState('');
  const [username, setUsername] = useState(storedUser);
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [idleUserIds, setIdleUserIds] = useState<string[]>([]); 
  const [selectedUserId, setSelectedUserId] = useState('');
  const [search, setSearch] = useState('');
  const [messagesByConv, setMessagesByConv] = useState<Record<string, Message[]>>({});
  const [draft, setDraft] = useState('');
  const [typingFrom, setTypingFrom] = useState<Record<string, boolean>>({});
  const [callState, setCallState] = useState<CallState>(null);
  const [incomingFromUserId, setIncomingFromUserId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState('');
  const [scrollThumb, setScrollThumb] = useState({ top: 0, height: 0 });
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [contextMenu, setContextMenu] = useState<null | { messageId: string; x: number; y: number }>(null);
  const [incomingCallMode, setIncomingCallMode] = useState<CallMode | null>(null);
  const incomingCallModeRef = useRef<CallMode | null>(null);

  const usersRef = useRef<User[]>([]);
  const selectedUserIdRef = useRef('');
  const socketRef = useRef<Socket | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(null);
  const [remoteStreamState, setRemoteStreamState] = useState<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentCallRef = useRef<CallState>(null);
  const messagesRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const incomingFromUserIdRef = useRef<string | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const [isWindowActive, setIsWindowActive] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus()
  );
  
  const isWindowActiveRef = useRef(isWindowActive);
  const activeMessagesRef = useRef<Message[]>([]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [deleteChatTargetUserId, setDeleteChatTargetUserId] = useState<string | null>(null);
  const deleteChatTarget = users.find((u) => u.id === deleteChatTargetUserId) || null;
  const [deleteMessageTargetId, setDeleteMessageTargetId] = useState<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const pendingUploadsRef = useRef<PendingUpload[]>([]);

  const desktopApi = window.desktop ?? {
    getConfig: async () => ({
      platform: 'web',
      appVersion: 'browser'
    }),
    startHost: async (_opts: { port: number }) => {
      throw new Error('Host mode is only available in Electron desktop');
    },
    notify: async (_opts: { title: string; body: string; userId?: string; kind?: 'message' | 'call' }) => {},
    onOpenFileDialog: async () => [],
    onNavigateToChat: (_callback: (payload: { userId: string; kind: 'message' | 'call' }) => void) => () => {}
  };

  useEffect(() => {
    currentCallRef.current = callState;
  }, [callState]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    selectedUserIdRef.current = selectedUserId;
  }, [selectedUserId]);

  useEffect(() => {
    incomingFromUserIdRef.current = incomingFromUserId;
  }, [incomingFromUserId]);

  useEffect(() => {
    isWindowActiveRef.current = isWindowActive;
  }, [isWindowActive]);
  
  useEffect(() => {
    incomingCallModeRef.current = incomingCallMode;
  }, [incomingCallMode]);

  useEffect(() => {
    pendingUploadsRef.current = pendingUploads;
  }, [pendingUploads]);
  
  useEffect(() => {
    return () => {
      pendingUploadsRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    function preventWindowDrop(event: DragEvent) {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
        event.preventDefault();
      }
    }
  
    window.addEventListener('dragover', preventWindowDrop);
    window.addEventListener('drop', preventWindowDrop);
  
    return () => {
      window.removeEventListener('dragover', preventWindowDrop);
      window.removeEventListener('drop', preventWindowDrop);
    };
  }, []);

  useEffect(() => {
    if (!remoteAudioRef.current) return;
  
    if (callState?.mode === 'audio' && remoteStreamState) {
      remoteAudioRef.current.srcObject = remoteStreamState;
    } else {
      remoteAudioRef.current.srcObject = null;
    }
  }, [callState, remoteStreamState]);

  useEffect(() => {
    const updateWindowActive = () => {
      const active = document.visibilityState === 'visible' && document.hasFocus();
      setIsWindowActive(active);
    };
  
    updateWindowActive();
  
    window.addEventListener('focus', updateWindowActive);
    window.addEventListener('blur', updateWindowActive);
    document.addEventListener('visibilitychange', updateWindowActive);
  
    return () => {
      window.removeEventListener('focus', updateWindowActive);
      window.removeEventListener('blur', updateWindowActive);
      document.removeEventListener('visibilitychange', updateWindowActive);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = desktopApi.onNavigateToChat?.(({ userId, kind }) => {
      autoScrollRef.current = true;
      setSelectedUserId(userId);

      if (kind === 'call') {
        setIncomingFromUserId(userId);
        setCallStatus(`${userNameFromList(userId, usersRef.current)} is calling...`);
      }

      if (me && connectedServerUrl) {
        void loadHistory(userId, true);
      } else {
        smoothScrollToBottom(true, false);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [me, connectedServerUrl]);

  useEffect(() => {
    function closeContextMenu() {
      setContextMenu(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    }

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    desktopApi.getConfig().then(setAppInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamState;
  }, [localStreamState]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamState;
  }, [remoteStreamState]);

  useEffect(() => {
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socketRef.current || !me) return;
  
    socketRef.current.emit('presence:set-state', {
      state: isWindowActive ? 'online' : 'idle'
    });
  }, [isWindowActive, me]);

  useEffect(() => {
    if (!socketRef.current || !me) return;
  
    socketRef.current.emit('presence:set-state', {
      state: callState ? 'online' : isWindowActive ? 'online' : 'idle'
    });
  }, [isWindowActive, me, callState]);

  useEffect(() => {
    resizeComposerTextarea();
  }, [draft, replyingTo]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
  
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (autoScrollRef.current) {
          scrollToBottom(true, false);
        }
        updateMessageScrollbar();
      });
    });
  
    observer.observe(el);
  
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setReplyingTo(null);
    setDeleteChatTargetUserId(null);
    setDeleteMessageTargetId(null);
    setIncomingCallMode(null);
    incomingCallModeRef.current = null;
    clearPendingUploads();
  }, [selectedUserId]);

  async function handleConnect() {
    if (hostMode && !window.desktop?.startHost) {
      alert('Host mode is only available in the Electron desktop app.');
      return;
    }

    if (!username.trim()) {
      alert('Enter a display name.');
      return;
    }

    let serverUrl = serverUrlInput.trim();

    if (hostMode) {
      const started = await desktopApi.startHost({ port: hostPort });
      setHostAddresses(started.addresses);
      serverUrl = started.serverUrl;
      setServerUrlInput(serverUrl);
    }

    const loginRes = await fetch(`${serverUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: username.trim() })
    });

    const loginData = await loginRes.json();

    if (!loginRes.ok) {
      alert(loginData.error || 'Failed to log in');
      return;
    }

    localStorage.setItem('lan_chat_user_name', username.trim());
    localStorage.setItem('lan_chat_server_url', serverUrl);
    localStorage.setItem('lan_chat_host_mode', hostMode ? '1' : '0');

    setMe(loginData.user);
    setUsers(loginData.users || []);
    setConnectedServerUrl(serverUrl);

    const socket = io(serverUrl, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('auth:join', { userId: loginData.user.id });
      socket.emit(
        'users:sync',
        (payload: { users: User[]; onlineUserIds: string[]; idleUserIds: string[] }) => {
          setUsers(payload.users);
          setOnlineUserIds(payload.onlineUserIds || []);
          setIdleUserIds(payload.idleUserIds || []);
          const fallback = payload.users.find((u) => u.id !== loginData.user.id)?.id || '';
          setSelectedUserId((curr) => curr || fallback);
        }
      );
    });

    socket.on(
      'message:status',
      ({ messageId, deliveredAt, readAt }: { messageId: string; deliveredAt: number | null; readAt: number | null }) => {
        setMessagesByConv((prev) => {
          const next: Record<string, Message[]> = {};

          for (const [key, items] of Object.entries(prev)) {
            next[key] = items.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    deliveredAt: deliveredAt ?? m.deliveredAt,
                    readAt: readAt ?? m.readAt
                  }
                : m
            );
          }

          return next;
        });
      }
    );

    socket.on(
      'conversation:cleared-for-me',
      ({
        conversationKey: clearedConversationKey
      }: {
        conversationKey: string;
        userId: string;
        peerUserId: string;
        clearedAt: number;
      }) => {
        clearConversationLocally(clearedConversationKey);
        setDeleteChatTargetUserId(null);
      }
    );

    socket.on(
      'message:cleared-for-me',
      ({
        messageId,
        conversationKey: clearedConversationKey
      }: {
        messageId: string;
        conversationKey: string;
        userId: string;
        hiddenAt: number;
      }) => {
        clearMessageLocally(messageId, clearedConversationKey);
        setDeleteMessageTargetId(null);
      }
    );

    socket.on('users:changed', () => {
      socket.emit(
        'users:sync',
        (payload: { users: User[]; onlineUserIds: string[]; idleUserIds: string[] }) => {
          setUsers(payload.users);
          setOnlineUserIds(payload.onlineUserIds || []);
          setIdleUserIds(payload.idleUserIds || []);
        }
      );
    });

    socket.on(
      'presence:update',
      (payload: { onlineUserIds: string[]; idleUserIds: string[] }) => {
        setOnlineUserIds(payload.onlineUserIds || []);
        setIdleUserIds(payload.idleUserIds || []);
      }
    );

    socket.on('message:new', (message: Message) => {
      setMessagesByConv((prev) => {
        const key = message.conversationKey;
        const next = [...(prev[key] || []), message];
        return { ...prev, [key]: next };
      });

      const isNormalNotifyMessage = message.type === 'text' || message.type === 'file';

      if (message.fromUserId !== loginData.user.id && isNormalNotifyMessage) {
        const senderName = usersRef.current.find((u) => u.id === message.fromUserId)?.name || 'New message';
        const attachments = getMessageAttachments(message);

        const body =
          isGalleryMessage(message)
            ? `${senderName} sent ${attachments.length} photos${message.text ? `: ${message.text}` : ''}`
            : message.type === 'file'
            ? `${senderName} sent ${attachments[0]?.isImage ? 'an image' : 'a file'}: ${attachments[0]?.filename || ''}`
            : message.text;

        desktopApi.notify({
          title: senderName,
          body,
          userId: message.fromUserId,
          kind: 'message'
        });
      }

      if (message.toUserId === loginData.user.id) {
        socket.emit('message:delivered', {
          messageId: message.id,
          byUserId: loginData.user.id
        });
      
        if (canMarkConversationAsRead(message.fromUserId)) {
          socket.emit('message:read', {
            messageId: message.id,
            byUserId: loginData.user.id
          });
        }
      }
    });

    socket.on('message:deleted', (message: Message) => {
      setMessagesByConv((prev) => {
        const key = message.conversationKey;
        const next = (prev[key] || []).map((m) => (m.id === message.id ? message : m));
        return { ...prev, [key]: next };
      });
    });

    socket.on('typing:update', ({ fromUserId, isTyping }: { fromUserId: string; isTyping: boolean }) => {
      setTypingFrom((prev) => ({ ...prev, [fromUserId]: isTyping }));
    });

    socket.on('call:invite', ({ fromUserId, mode }: { fromUserId: string; mode?: CallMode }) => {
      const callMode = mode === 'audio' ? 'audio' : 'video';
    
      incomingFromUserIdRef.current = fromUserId;
      incomingCallModeRef.current = callMode;
    
      setIncomingFromUserId(fromUserId);
      setIncomingCallMode(callMode);
    
      const senderName = usersRef.current.find((u) => u.id === fromUserId)?.name || 'Incoming call';
      setCallStatus(
        callMode === 'audio'
          ? `${senderName} is voice calling...`
          : `${senderName} is video calling...`
      );
    
      desktopApi.notify({
        title: callMode === 'audio' ? 'Incoming voice call' : 'Incoming video call',
        body: `${senderName} is calling you`,
        userId: fromUserId,
        kind: 'call'
      });
    });

    socket.on(
      'conversation:deleted',
      ({
        conversationKey: deletedConversationKey
      }: {
        conversationKey: string;
        byUserId: string;
        peerUserId: string;
      }) => {
        clearConversationLocally(deletedConversationKey);
        setDeleteChatTargetUserId(null);
      }
    );

    socket.on('call:accepted', async ({ fromUserId, mode }: { fromUserId: string; mode?: CallMode }) => {
      if (currentCallRef.current?.peerUserId !== fromUserId) return;
    
      const callMode = currentCallRef.current?.mode || mode || 'video';
    
      setCallState((prev) => (prev ? { ...prev, phase: 'connecting', mode: callMode } : prev));
      setCallStatus(
        callMode === 'audio'
          ? 'Creating secure local voice connection...'
          : 'Creating secure local video connection...'
      );
    
      const stream = await ensureLocalStream(callMode);
      const peer = createPeer(fromUserId, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
    
      socket.emit('signal', {
        fromUserId: loginData.user.id,
        toUserId: fromUserId,
        data: { type: 'offer', payload: offer }
      });
    });

    socket.on('call:declined', ({ fromUserId }: { fromUserId: string }) => {
      if (currentCallRef.current?.peerUserId === fromUserId) {
        setCallStatus('Call declined');
        cleanupCall(false);
      }
    });

    socket.on('call:ended', ({ fromUserId }: { fromUserId: string }) => {
      const isIncomingDialogOpen = incomingFromUserIdRef.current === fromUserId;
      const isCurrentCallPeer = currentCallRef.current?.peerUserId === fromUserId;

      if (!isIncomingDialogOpen && !isCurrentCallPeer) return;

      incomingFromUserIdRef.current = null;
      cleanupCall(false);
      setIncomingFromUserId(null);
      setCallStatus('Call ended');
    });

    socket.on(
      'signal',
      async ({
        fromUserId,
        data
      }: {
        fromUserId: string;
        data: { type: 'offer' | 'answer' | 'candidate'; payload: any };
      }) => {
        try {
          if (data.type === 'offer') {
            const callMode = currentCallRef.current?.mode || incomingCallModeRef.current || 'video';
            const stream = await ensureLocalStream(callMode);
            const peer = createPeer(fromUserId, stream);
            await peer.setRemoteDescription(new RTCSessionDescription(data.payload));
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);

            socket.emit('signal', {
              fromUserId: loginData.user.id,
              toUserId: fromUserId,
              data: { type: 'answer', payload: answer }
            });

            const nextCallState: CallState = {
              peerUserId: fromUserId,
              mode: callMode,
              phase: 'connecting',
              muted: false,
              cameraOff: callMode === 'audio'
            };

            currentCallRef.current = nextCallState;
            setCallState(nextCallState);
          }

          if (data.type === 'answer' && peerRef.current) {
            await peerRef.current.setRemoteDescription(new RTCSessionDescription(data.payload));
          }

          if (data.type === 'candidate' && peerRef.current) {
            await peerRef.current.addIceCandidate(new RTCIceCandidate(data.payload));
          }
        } catch (error) {
          console.error('signal failure', error);
        }
      }
    );
  }

  function createPeer(remoteUserId: string, stream: MediaStream) {
    if (peerRef.current) return peerRef.current;

    const socket = socketRef.current;
    if (!socket || !me) throw new Error('Socket not ready');

    const peer = new RTCPeerConnection();
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          fromUserId: me.id,
          toUserId: remoteUserId,
          data: { type: 'candidate', payload: event.candidate }
        });
      }
    };

    peer.ontrack = (event) => {
      setRemoteStreamState(event.streams[0]);
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setCallState((prev) => (prev ? { ...prev, phase: 'connected' } : prev));
        setCallStatus('Connected');
      }

      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
        cleanupCall(false);
      }
    };

    peerRef.current = peer;
    return peer;
  }

  function guessMimeTypeFromName(fileName: string) {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'txt') return 'text/plain';
    return '';
  }
  
  function revokePendingUpload(item: PendingUpload) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
  
  function createPendingUpload(input: {
    file: Blob;
    fileName: string;
    mimeType?: string;
  }): PendingUpload {
    const mimeType =
      input.mimeType ||
      (input.file instanceof File ? input.file.type : '') ||
      guessMimeTypeFromName(input.fileName);
  
    const isImage = mimeType.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(input.file) : null;
  
    return {
      id: `pu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file: input.file,
      fileName: input.fileName,
      mimeType,
      size: input.file.size,
      isImage,
      previewUrl
    };
  }
  
  function addPendingUploads(items: Array<{ file: Blob; fileName: string; mimeType?: string }>) {
    if (!items.length) return;
  
    const nextItems = items.map(createPendingUpload);
    setPendingUploads((prev) => [...prev, ...nextItems]);
  }
  
  function removePendingUpload(id: string) {
    setPendingUploads((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) revokePendingUpload(target);
      return prev.filter((item) => item.id !== id);
    });
  }
  
  function clearPendingUploads() {
    setPendingUploads((prev) => {
      prev.forEach(revokePendingUpload);
      return [];
    });
  }

  async function ensureLocalStream(mode: CallMode) {
    if (localStreamRef.current) return localStreamRef.current;
  
    const constraints =
      mode === 'audio'
        ? { audio: true }
        : { audio: true, video: true };
  
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
  
    localStreamRef.current = stream;
    setLocalStreamState(stream);
    return stream;
  }

  function cleanupCall(notifyPeer: boolean) {
    const peerUserId =
      currentCallRef.current?.peerUserId || callState?.peerUserId || incomingFromUserIdRef.current;

    if (notifyPeer && peerUserId && socketRef.current && me) {
      socketRef.current.emit('call:end', {
        fromUserId: me.id,
        toUserId: peerUserId
      });
    }

    peerRef.current?.close();
    peerRef.current = null;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    localStreamRef.current = null;
    currentCallRef.current = null;
    incomingFromUserIdRef.current = null;

    setLocalStreamState(null);
    setRemoteStreamState(null);
    setCallState(null);
    setIncomingFromUserId(null);
    setIncomingCallMode(null);
    incomingCallModeRef.current = null;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }

  function updateMessageScrollbar() {
    const el = messagesRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;

    if (scrollHeight <= clientHeight) {
      setScrollThumb({ top: 0, height: 0 });
      return;
    }

    const trackHeight = clientHeight - 16;
    const thumbHeight = Math.max((clientHeight / scrollHeight) * trackHeight, 36);
    const maxThumbTop = trackHeight - thumbHeight;
    const maxScrollTop = scrollHeight - clientHeight;
    const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0;

    setScrollThumb({
      top: thumbTop + 8,
      height: thumbHeight
    });
  }

  async function loadHistory(peerUserId: string, forceScroll = false) {
    if (!connectedServerUrl || !me) return;

    const res = await fetch(`${connectedServerUrl}/api/messages/${me.id}/${peerUserId}`);
    const data = await res.json();

    setMessagesByConv((prev) => ({
      ...prev,
      [conversationKey(me.id, peerUserId)]: data.messages || []
    }));

    if (forceScroll) {
      autoScrollRef.current = true;
      smoothScrollToBottom(true, false);
    }
  }

  async function sendMessage() {
    if (pendingUploads.length > 0) {
      await uploadPreparedFiles(pendingUploads);
      return;
    }
  
    if (!socketRef.current || !me || !selectedUserId || !draft.trim()) return;
  
    const text = draft.trim();
    setDraft('');
    stopTyping();
    autoScrollRef.current = true;
  
    socketRef.current.emit('message:send', {
      fromUserId: me.id,
      toUserId: selectedUserId,
      text,
      replyToMessageId: replyingTo?.id || null
    });
  
    setReplyingTo(null);
  
    requestAnimationFrame(() => {
      resizeComposerTextarea(true);
      focusComposer(false);
    });
  
    smoothScrollToBottom(true, false);
  }

  async function sendAttachment() {
    if (!me || !selectedUserId || !connectedServerUrl) return;
  
    const filePaths = await desktopApi.onOpenFileDialog();
    if (!filePaths?.length) return;
  
    const prepared: Array<{ file: Blob; fileName: string; mimeType?: string }> = [];
  
    for (const filePath of filePaths) {
      const parts = filePath.split(/[/\\]/);
      const fileName = parts[parts.length - 1];
  
      const blob = await fetch(pathToFileUrl(filePath))
        .then((r) => r.blob())
        .catch(() => null);
  
      if (!blob) {
        alert(`Unable to read the selected file: ${fileName}`);
        return;
      }
  
      prepared.push({
        file: blob,
        fileName,
        mimeType: blob.type || guessMimeTypeFromName(fileName)
      });
    }
  
    addPendingUploads(prepared);
    focusComposer();
  }

  function pathToFileUrl(filePath: string) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.startsWith('file://') ? normalized : `file:///${normalized}`;
  }

  function openDeleteMessageDialog(messageId: string) {
    setDeleteMessageTargetId(messageId);
    setContextMenu(null);
  }
  
  function clearMessageForMe() {
    if (!socketRef.current || !me || !deleteMessageTarget) return;
  
    socketRef.current.emit(
      'message:clear-for-me',
      {
        userId: me.id,
        messageId: deleteMessageTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          alert(result?.error || 'Failed to delete message for you');
        }
      }
    );
  }
  
  function deleteMessageForEveryone() {
    if (!socketRef.current || !me || !deleteMessageTarget) return;
  
    socketRef.current.emit(
      'message:delete',
      {
        messageId: deleteMessageTarget.id,
        byUserId: me.id
      },
      (result: { ok: boolean; error?: string; message?: Message }) => {
        if (!result?.ok) {
          alert(result?.error || 'Delete failed');
          return;
        }
  
        setDeleteMessageTargetId(null);
      }
    );
  }

  function startTyping() {
    if (!socketRef.current || !me || !selectedUserId) return;

    socketRef.current.emit('typing:set', {
      fromUserId: me.id,
      toUserId: selectedUserId,
      isTyping: true
    });

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => stopTyping(), 1200);
  }

  function stopTyping() {
    if (!socketRef.current || !me || !selectedUserId) return;

    socketRef.current.emit('typing:set', {
      fromUserId: me.id,
      toUserId: selectedUserId,
      isTyping: false
    });

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
  }

  function startCall(mode: CallMode) {
    if (!socketRef.current || !me || !selectedUserId) return;
  
    const nextCallState: CallState = {
      peerUserId: selectedUserId,
      mode,
      phase: 'outgoing',
      muted: false,
      cameraOff: mode === 'audio'
    };
  
    currentCallRef.current = nextCallState;
    setCallState(nextCallState);
    setCallStatus(
      mode === 'audio'
        ? `Voice calling ${userName(selectedUserId)}...`
        : `Video calling ${userName(selectedUserId)}...`
    );
  
    ensureLocalStream(mode).catch(() =>
      setCallStatus(mode === 'audio' ? 'Microphone permission denied' : 'Camera/microphone permission denied')
    );
  
    socketRef.current.emit('call:invite', {
      fromUserId: me.id,
      toUserId: selectedUserId,
      mode
    });
  }

  function acceptCall() {
    if (!incomingFromUserId || !socketRef.current || !me) return;
  
    const mode = incomingCallModeRef.current || 'video';
  
    const nextCallState: CallState = {
      peerUserId: incomingFromUserId,
      mode,
      phase: 'incoming',
      muted: false,
      cameraOff: mode === 'audio'
    };
  
    currentCallRef.current = nextCallState;
    incomingFromUserIdRef.current = null;
    setCallState(nextCallState);
  
    ensureLocalStream(mode).catch(() =>
      setCallStatus(mode === 'audio' ? 'Microphone permission denied' : 'Camera/microphone permission denied')
    );
  
    socketRef.current.emit('call:accept', {
      fromUserId: me.id,
      toUserId: incomingFromUserId
    });
  
    setIncomingFromUserId(null);
    setIncomingCallMode(null);
    incomingCallModeRef.current = null;
  
    setCallStatus(
      mode === 'audio'
        ? `Connecting voice call to ${userName(incomingFromUserId)}...`
        : `Connecting video call to ${userName(incomingFromUserId)}...`
    );
  }

  function declineCall() {
    if (!incomingFromUserId || !socketRef.current || !me) return;
    socketRef.current.emit('call:decline', { fromUserId: me.id, toUserId: incomingFromUserId });
    incomingFromUserIdRef.current = null;
    setIncomingFromUserId(null);
    setIncomingCallMode(null);
    incomingCallModeRef.current = null;
  }

  function toggleMute() {
    if (!currentCallRef.current || !localStreamRef.current) return;

    const nextMuted = !currentCallRef.current.muted;
    localStreamRef.current.getAudioTracks().forEach((track) => (track.enabled = !nextMuted));
    setCallState((prev) => (prev ? { ...prev, muted: nextMuted } : prev));
  }

  function toggleCamera() {
    if (!currentCallRef.current || currentCallRef.current.mode === 'audio' || !localStreamRef.current) return;
  
    const nextOff = !currentCallRef.current.cameraOff;
    localStreamRef.current.getVideoTracks().forEach((track) => (track.enabled = !nextOff));
    setCallState((prev) => (prev ? { ...prev, cameraOff: nextOff } : prev));
  }

  function canMarkConversationAsRead(peerUserId: string) {
    return (
      !!me &&
      selectedUserIdRef.current === peerUserId &&
      autoScrollRef.current &&
      isWindowActiveRef.current
    );
  }
  
  function markUnreadMessagesAsRead(peerUserId: string, sourceMessages: Message[]) {
    if (!socketRef.current || !me) return;
    if (!canMarkConversationAsRead(peerUserId)) return;
  
    sourceMessages
      .filter(
        (m) =>
          m.fromUserId === peerUserId &&
          m.toUserId === me.id &&
          m.type !== 'deleted' &&
          !m.readAt
      )
      .forEach((m) => {
        socketRef.current?.emit('message:read', {
          messageId: m.id,
          byUserId: me.id
        });
      });
  }

  function resizeComposerTextarea(resetToOneRow = false) {
    const el = composerInputRef.current;
    if (!el) return;
  
    if (resetToOneRow) {
      el.style.height = 'auto';
      return;
    }
  
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  function focusComposer(moveCaretToEnd = true) {
    requestAnimationFrame(() => {
      const el = composerInputRef.current;
      if (!el) return;
  
      el.focus();
  
      if (moveCaretToEnd) {
        const length = el.value.length;
        el.setSelectionRange(length, length);
      }
    });
  }

  function getPresence(userId: string): 'online' | 'idle' | 'offline' {
    if (idleUserIds.includes(userId)) return 'idle';
    if (onlineUserIds.includes(userId)) return 'online';
    return 'offline';
  }

  function clearConversationLocally(conversationKeyValue: string) {
    setMessagesByConv((prev) => {
      const next = { ...prev };
      delete next[conversationKeyValue];
      return next;
    });
  
    const activeKey =
      me && selectedUserIdRef.current ? conversationKey(me.id, selectedUserIdRef.current) : '';
  
    if (conversationKeyValue === activeKey) {
      setReplyingTo(null);
      setContextMenu(null);
  
      requestAnimationFrame(() => {
        resizeComposerTextarea(true);
        focusComposer(false);
        syncMessageViewportState();
      });
    }
  }

  function clearMessageLocally(messageId: string, conversationKeyValue: string) {
    setMessagesByConv((prev) => {
      const next = { ...prev };
      next[conversationKeyValue] = (next[conversationKeyValue] || []).filter((m) => m.id !== messageId);
      return next;
    });
  
    if (replyingTo?.id === messageId) {
      setReplyingTo(null);
    }
  
    if (contextMenu?.messageId === messageId) {
      setContextMenu(null);
    }
  
    requestAnimationFrame(() => {
      syncMessageViewportState();
    });
  }

  function userName(userId: string) {
    return users.find((u) => u.id === userId)?.name || userId;
  }

  function isFileDrag(event: React.DragEvent | DragEvent) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  
  async function uploadPreparedFiles(files: PendingUpload[]) {
    if (!me || !selectedUserId || !connectedServerUrl) return false;
    if (!files.length) return false;
  
    const textForMessage = draft.trim();
    const replyTarget = replyingTo;
    const canSendAsGallery = files.length > 1 && files.every((item) => item.isImage);
  
    stopTyping();
    autoScrollRef.current = true;
  
    if (canSendAsGallery) {
      const form = new FormData();
  
      files.forEach((item) => {
        form.append('files', item.file, item.fileName);
      });
  
      form.append('fromUserId', me.id);
      form.append('toUserId', selectedUserId);
      form.append('text', textForMessage);
  
      if (replyTarget?.id) {
        form.append('replyToMessageId', replyTarget.id);
      }
  
      const res = await fetch(`${connectedServerUrl}/api/upload`, {
        method: 'POST',
        body: form
      });
  
      const data = await res.json().catch(() => ({}));
  
      if (!res.ok) {
        alert(data.error || 'Gallery upload failed');
        return false;
      }
    } else {
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        const form = new FormData();
  
        form.append('file', item.file, item.fileName);
        form.append('fromUserId', me.id);
        form.append('toUserId', selectedUserId);
        form.append('text', i === 0 ? textForMessage : '');
  
        if (i === 0 && replyTarget?.id) {
          form.append('replyToMessageId', replyTarget.id);
        }
  
        const res = await fetch(`${connectedServerUrl}/api/upload`, {
          method: 'POST',
          body: form
        });
  
        const data = await res.json().catch(() => ({}));
  
        if (!res.ok) {
          alert(data.error || `Upload failed: ${item.fileName}`);
          return false;
        }
      }
    }
  
    clearPendingUploads();
    setDraft('');
    setReplyingTo(null);
  
    requestAnimationFrame(() => {
      resizeComposerTextarea(true);
      focusComposer(false);
    });
  
    smoothScrollToBottom(true, false);
    return true;
  }
  
  function handleChatDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData?.items || []);
  
    const pastedFiles = items
      .filter((item) => item.kind === 'file')
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
  
        const fallbackName = file.type.startsWith('image/')
          ? `pasted-image-${Date.now()}-${index + 1}.png`
          : `pasted-file-${Date.now()}-${index + 1}`;
  
        return {
          file,
          fileName: file.name || fallbackName,
          mimeType: file.type
        };
      })
      .filter(Boolean) as Array<{ file: Blob; fileName: string; mimeType?: string }>;
  
    if (!pastedFiles.length) return;
  
    event.preventDefault();
    addPendingUploads(pastedFiles);
  }
  
  function handleChatDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
  
  function handleChatDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
  
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }
  
  async function handleChatDrop(event: React.DragEvent<HTMLElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
  
    dragDepthRef.current = 0;
    setIsDragOver(false);
  
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    if (!droppedFiles.length) return;
  
    addPendingUploads(
      droppedFiles.map((file) => ({
        file,
        fileName: file.name,
        mimeType: file.type
      }))
    );
  
    focusComposer();
  }
  function userNameFromList(userId: string, list: User[]) {
    return list.find((u) => u.id === userId)?.name || userId;
  }

  function messageStatusType(message: Message) {
    if (message.type === 'deleted') return 'none';
    if (message.readAt) return 'read';
    if (message.deliveredAt) return 'delivered';
    return 'sent';
  }

  function MessageStatus({ message }: { message: Message }) {
    const status = messageStatusType(message);
    if (status === 'none') return null;
  
    if (status === 'sent') {
      return (
        <span className={`tg-status ${status}`} aria-label="sent">
          <svg className="tg-status-svg tg-status-single" viewBox="0 0 12 10">
            <path d="M1.6 5.3L4.5 8.1L10.2 2.2" />
          </svg>
        </span>
      );
    }
  
    return (
      <span className={`tg-status ${status}`} aria-label={status}>
        <svg className="tg-status-svg tg-status-double" viewBox="0 0 18 10">
          <path d="M1.6 5.3L4.5 8.1L10.2 2.2" />
          <path d="M7.2 5.3L10.1 8.1L15.8 2.2" />
        </svg>
      </span>
    );
  }

  function scrollToBottom(force = false, smooth = false) {
    const el = messagesRef.current;
    if (!el) return;

    if (force || autoScrollRef.current) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    }
  }

  function smoothScrollToBottom(force = false, smooth = true) {
    requestAnimationFrame(() => {
      scrollToBottom(force, smooth);
  
      requestAnimationFrame(() => {
        syncMessageViewportState();
      });
    });
  }

  function handleMessagesScroll() {
    syncMessageViewportState();
  
    if (selectedUserIdRef.current && autoScrollRef.current) {
      markUnreadMessagesAsRead(selectedUserIdRef.current, activeMessagesRef.current);
    }
  }

  function syncMessageViewportState() {
    const el = messagesRef.current;
    if (!el) return;
  
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAwayFromBottom = distanceFromBottom >= 80;
  
    autoScrollRef.current = !isAwayFromBottom;
    setShowScrollToBottom(isAwayFromBottom);
    updateMessageScrollbar();
  }

  function clearCurrentConversationForMe() {
    if (!socketRef.current || !me || !deleteChatTarget) return;
  
    socketRef.current.emit(
      'conversation:clear-for-me',
      {
        userId: me.id,
        peerUserId: deleteChatTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          alert(result?.error || 'Failed to delete chat for you');
        }
      }
    );
  }
  
  function deleteCurrentConversationForEveryone() {
    if (!socketRef.current || !me || !deleteChatTarget) return;
  
    socketRef.current.emit(
      'conversation:delete',
      {
        userId: me.id,
        peerUserId: deleteChatTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          alert(result?.error || 'Failed to delete chat for everyone');
        }
      }
    );
  }

  function deletedMessageLabel(message: Message, meId: string) {
    return message.deletedByUserId === meId ? ' You deleted a message' : ' This message was deleted';
  }

  function openMessageContextMenu(event: React.MouseEvent, messageId: string) {
    event.preventDefault();

    const menuWidth = 170;
    const menuHeight = 96;
    const padding = 8;

    const x = Math.min(event.clientX, window.innerWidth - menuWidth - padding);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - padding);

    setContextMenu({ messageId, x, y });
  }

  function replyPreviewText(replyTo: ReplyTo) {
    if (replyTo.attachmentName) {
      return replyTo.isImage ? 'Photo' : replyTo.attachmentName;
    }
    return replyTo.text || 'Message';
  }

  function replyPreviewTextFromMessage(message: Message) {
    const attachments = getMessageAttachments(message);
  
    if (isGalleryMessage(message)) {
      return message.text || `${attachments.length} photos`;
    }
  
    if (attachments.length === 1) {
      return attachments[0].isImage ? 'Photo' : attachments[0].filename;
    }
  
    if (message.type === 'deleted') return 'Message deleted';
    return message.text || 'Message';
  }

  function startReply(messageId: string) {
    const target = activeMessages.find((m) => m.id === messageId);
    if (!target) return;
  
    setReplyingTo(target);
    setContextMenu(null);
    autoScrollRef.current = true;
  
    focusComposer();
    smoothScrollToBottom(true, false);
  }

  function scrollToMessage(messageId: string) {
    const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash-target');

    window.setTimeout(() => {
      el.classList.remove('flash-target');
    }, 1200);
  }

  const visibleUsers = useMemo(() => {
    if (!me) return [] as User[];

    const filtered = users.filter((u) => u.id !== me.id && u.name.toLowerCase().includes(search.toLowerCase()));

    return filtered.sort((a, b) => {
      const aMsgs = messagesByConv[conversationKey(me.id, a.id)] || [];
      const bMsgs = messagesByConv[conversationKey(me.id, b.id)] || [];
      const aLast = aMsgs.length ? aMsgs[aMsgs.length - 1].createdAt : 0;
      const bLast = bMsgs.length ? bMsgs[bMsgs.length - 1].createdAt : 0;
      return bLast - aLast || a.name.localeCompare(b.name);
    });
  }, [users, me, search, messagesByConv]);

  const selectedUser = users.find((u) => u.id === selectedUserId) || null;

  const activeMessages = useMemo(() => {
    if (!me || !selectedUserId) return [] as Message[];
    return messagesByConv[conversationKey(me.id, selectedUserId)] || [];
  }, [messagesByConv, me, selectedUserId]);

  const deleteMessageTarget = useMemo(() => {
    if (!deleteMessageTargetId) return null;
    return activeMessages.find((m) => m.id === deleteMessageTargetId) || null;
  }, [deleteMessageTargetId, activeMessages]);

  useEffect(() => {
    activeMessagesRef.current = activeMessages;
  }, [activeMessages]);  

  const contextTargetMessage = useMemo(() => {
    if (!contextMenu) return null;
    return activeMessages.find((m) => m.id === contextMenu.messageId) || null;
  }, [contextMenu, activeMessages]);

  useEffect(() => {
    if (!connectedServerUrl || !me || !selectedUserId) return;
    void loadHistory(selectedUserId);
  }, [selectedUserId, me, connectedServerUrl]);

  useEffect(() => {
    if (!replyingTo) return;
    focusComposer();
  }, [replyingTo]);

  useEffect(() => {
    if (!selectedUserId) return;
    focusComposer();
  }, [selectedUserId]);

  useEffect(() => {
    if (!selectedUserId) return;
    markUnreadMessagesAsRead(selectedUserId, activeMessages);
  }, [activeMessages, selectedUserId, isWindowActive]);

  // useEffect(() => {
  //   requestAnimationFrame(() => {
  //     syncMessageViewportState();
  //   });
  // }, [activeMessages]);

  useEffect(() => {
    smoothScrollToBottom(true, false);
  }, [activeMessages]);

  useEffect(() => {
    smoothScrollToBottom(true, false);
  }, [selectedUserId]);

  useEffect(() => {
    const onResize = () => updateMessageScrollbar();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!me) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="pill">Windows desktop</div>
          <h1>LAN Chat Desktop</h1>
          <p>One-to-one chat, file/image sending, message deletion, desktop notifications, and one-to-one video meetings over the local network.</p>

          <label className="field">
            <span>Display name</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Your name" />
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked={hostMode} onChange={(e) => setHostMode(e.target.checked)} />
            <span>Host the LAN server on this PC</span>
          </label>

          {hostMode ? (
            <label className="field">
              <span>Host port</span>
              <input type="number" value={hostPort} onChange={(e) => setHostPort(Number(e.target.value))} />
            </label>
          ) : (
            <label className="field">
              <span>Server URL</span>
              <input
                value={serverUrlInput}
                onChange={(e) => setServerUrlInput(e.target.value)}
                placeholder="http://192.168.1.25:4000"
              />
            </label>
          )}

          <button className="primary" onClick={handleConnect}>
            Enter app
          </button>

          {hostAddresses.length ? (
            <div className="host-box">
              <strong>Share this LAN address with other users:</strong>
              {hostAddresses.map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          ) : null}

          <div className="foot-note">
            App {appInfo?.appVersion || ''} · {appInfo?.platform || ''}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="profile-card">
            <div className="avatar large">{getInitials(me.name)}</div>
            <div>
              <div className="name">{me.name}</div>
              <div className="sub">{hostMode ? 'Hosting local server' : connectedServerUrl}</div>
            </div>
          </div>

          <button
            className="icon-btn"
            onClick={() => {
              cleanupCall(true);
              socketRef.current?.disconnect();
              setMe(null);
            }}
          >
            ⎋
          </button>
        </div>

        <div className="search-wrap">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Searching..." />
          <span>⌕</span>
        </div>

        <div className="tabs">
          <button className="tab active">Chats</button>
          <button className="tab">Calls</button>
          <button className="tab">Contacts</button>
          <button className="tab">Notification</button>
        </div>

        <div className="contact-list">
          {visibleUsers.map((user) => {
            const conv = messagesByConv[conversationKey(me.id, user.id)] || [];
            const last = conv[conv.length - 1];
            const online = onlineUserIds.includes(user.id);
            const presence = getPresence(user.id);

            return (
              <button
                key={user.id}
                className={`contact-card ${selectedUserId === user.id ? 'selected' : ''}`}
                onClick={() => setSelectedUserId(user.id)}
              >
                <div className="contact-avatar-wrap">
                  <div className="avatar" style={{ background: avatarBg(user.id) }}>
                    {getInitials(user.name)}
                  </div>
                  {presence !== 'offline' ? (
                    <span className={`online-dot ${presence === 'idle' ? 'idle' : ''}`} />
                  ) : null}
                </div>

                <div className="contact-text">
                  <div className="contact-head">
                    <span className="contact-name">{user.name}</span>
                    <span className="contact-time">{timeLabel(last?.createdAt)}</span>
                  </div>
                  <div className="contact-preview">{typingFrom[user.id] ? 'typing...' : previewText(last, me.id, users)}</div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main
        className={`chat-panel ${isDragOver ? 'drag-active' : ''}`}
        onDragEnter={handleChatDragEnter}
        onDragOver={handleChatDragOver}
        onDragLeave={handleChatDragLeave}
        onDrop={handleChatDrop}
      >
        {selectedUser ? (
          <>
            <header className="chat-header">
              <div className="chat-person">
                <div className="contact-avatar-wrap">
                  <div className="avatar" style={{ background: avatarBg(selectedUser.id) }}>
                    {getInitials(selectedUser.name)}
                  </div>
                  {getPresence(selectedUser.id) !== 'offline' ? (
                    <span className={`online-dot ${getPresence(selectedUser.id) === 'idle' ? 'idle' : ''}`} />
                  ) : null}
                </div>
                <div>
                  <div className="name">{selectedUser.name}</div>
                  <div className="sub">
                    {getPresence(selectedUser.id) === 'online'
                      ? 'Online'
                      : getPresence(selectedUser.id) === 'idle'
                      ? 'Idle'
                      : 'Offline'}
                  </div>
                </div>
              </div>

              <div className="header-actions">
                <button className="icon-btn" onClick={() => startCall('audio')} title="Audio call">
                  📞
                </button>
                <button className="icon-btn" onClick={() => startCall('video')} title="Video call">
                  🎥
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setDeleteChatTargetUserId(selectedUser.id)}
                  title="Delete chat"
                >
                  🗑
                </button>
              </div>
            </header>

            <div className="messages-wrap">
              <section className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
                {activeMessages.map((m, idx) => {
                  const mine = m.fromUserId === me.id;
                  const prev = activeMessages[idx - 1];
                  const next = activeMessages[idx + 1];

                  const showDivider =
                    !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();

                  const nextIsSameSenderGroup = isRenderableMessage(next) && next!.fromUserId === m.fromUserId;
                  const showAvatarForThisMessage = !nextIsSameSenderGroup;

                  const attachments = getMessageAttachments(m);
                  const isGallery = isGalleryMessage(m);
                  const useTelegramInlineMeta = !!m.text && attachments.length === 0;

                  return (
                    <div key={m.id} data-message-id={m.id}>
                      {showDivider ? <div className="divider">{dateDivider(m.createdAt)}</div> : null}

                      {m.type === 'call' || m.type === 'deleted' || m.type === 'system' ? (
                        <div className="system-chip-row">
                          <div className={systemChipClass(m)}>
                            <span className="system-chip-icon">{systemChipIcon(m, me.id)}</span>
                            <span className="system-chip-text">
                              {m.type === 'call'
                                ? callHistoryLabel(m, me.id, users)
                                : m.type === 'deleted'
                                ? deletedMessageLabel(m, me.id)
                                : systemMessageLabel(m, me.id, users)}
                            </span>
                            <span className="system-chip-time">{timeLabel(m.createdAt)}</span>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`message-row ${mine ? 'mine' : ''} ${showAvatarForThisMessage ? 'group-end' : 'group-middle'}`}
                          onContextMenu={(e) => openMessageContextMenu(e, m.id)}
                        >
                          {!mine ? (
                            showAvatarForThisMessage ? (
                              <div className="message-avatar">
                                <div className="avatar small" style={{ background: avatarBg(m.fromUserId) }}>
                                  {getInitials(userName(m.fromUserId))}
                                </div>
                              </div>
                            ) : (
                              <div className="message-avatar-spacer" />
                            )
                          ) : null}

                          <div className="message-stack">
                            <div className={`bubble ${mine ? 'mine' : ''} ${useTelegramInlineMeta ? 'telegram-inline-meta' : ''}`}>
                              {m.replyTo ? (
                                <button
                                  type="button"
                                  className={`reply-preview ${mine ? 'mine' : ''}`}
                                  onClick={() => scrollToMessage(m.replyTo!.messageId)}
                                >
                                  <span className="reply-preview-author">
                                    {m.replyTo.fromUserId === me.id ? 'You' : userName(m.replyTo.fromUserId)}
                                  </span>
                                  <span className="reply-preview-text">{replyPreviewText(m.replyTo)}</span>
                                </button>
                              ) : null}

                              {isGallery ? (
                                <GalleryPreview attachments={attachments} serverUrl={connectedServerUrl} />
                              ) : null}

                              {m.text ? (
                                useTelegramInlineMeta ? (
                                  <div className="message-text with-inline-meta">
                                    <span className="message-text-content">{m.text}</span>

                                    <span className="message-inline-meta-spacer" aria-hidden="true">
                                      <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                      {mine && m.type !== 'deleted' ? <MessageStatus message={m} /> : null}
                                    </span>

                                    <span className={`message-inline-meta ${mine ? 'mine' : ''}`}>
                                      <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                      {mine && m.type !== 'deleted' ? <MessageStatus message={m} /> : null}
                                    </span>
                                  </div>
                                ) : (
                                  <div className={`message-text ${isGallery ? 'gallery-caption' : ''}`}>
                                    {m.text}
                                  </div>
                                )
                              ) : null}

                              {!isGallery && attachments.length === 1 ? (
                                <AttachmentPreview attachment={attachments[0]} serverUrl={connectedServerUrl} />
                              ) : null}

                              {!useTelegramInlineMeta ? (
                                <div className={`bubble-meta ${mine ? 'mine' : ''}`}>
                                  <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                  {mine && m.type !== 'deleted' ? <MessageStatus message={m} /> : null}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {mine ? (
                            showAvatarForThisMessage ? (
                              <div className="message-avatar">
                                <div className="avatar small" style={{ background: avatarBg(me.id) }}>
                                  {getInitials(me.name)}
                                </div>
                              </div>
                            ) : (
                              <div className="message-avatar-spacer" />
                            )
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}

                {typingFrom[selectedUser.id] ? <div className="typing">{selectedUser.name} is typing...</div> : null}
              </section>

              <div className="messages-scrollbar">
                <div
                  className="messages-scrollbar-thumb"
                  style={{
                    height: `${scrollThumb.height}px`,
                    transform: `translateY(${scrollThumb.top}px)`
                  }}
                />
              </div>

              {showScrollToBottom ? (
                <button
                  className="scroll-bottom-btn"
                  onClick={() => {
                    autoScrollRef.current = true;
                    smoothScrollToBottom(true, true);

                    if (selectedUserIdRef.current) {
                      markUnreadMessagesAsRead(selectedUserIdRef.current, activeMessagesRef.current);
                    }
                  }}
                  aria-label="Scroll to bottom"
                  title="Scroll to bottom"
                >
                  ↓
                </button>
              ) : null}
            </div>

            <footer className="composer" ref={composerRef}>
              <button className="emoji-btn">☺</button>

              <div className="composer-center">
                {pendingUploads.length ? (
                  <div className="composer-attachments">
                    {pendingUploads.map((item) => (
                      <div key={item.id} className="composer-attachment">
                        {item.isImage && item.previewUrl ? (
                          <img
                            className="composer-attachment-thumb"
                            src={item.previewUrl}
                            alt={item.fileName}
                          />
                        ) : (
                          <div className="composer-attachment-file">📄</div>
                        )}

                        <div className="composer-attachment-meta">
                          <div className="composer-attachment-name">{item.fileName}</div>
                          <div className="composer-attachment-sub">
                            {item.isImage ? 'Photo' : `${Math.max(1, Math.round(item.size / 1024))} KB`}
                          </div>
                        </div>

                        <button
                          type="button"
                          className="composer-attachment-remove"
                          onClick={() => removePendingUpload(item.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {replyingTo ? (
                  <div className="reply-draft">
                    <div className="reply-draft-bar" />
                    <div className="reply-draft-body">
                      <div className="reply-draft-title">
                        Replying to {replyingTo.fromUserId === me.id ? 'You' : userName(replyingTo.fromUserId)}
                      </div>
                      <div className="reply-draft-text">{replyPreviewTextFromMessage(replyingTo)}</div>
                    </div>
                    <button
                      className="reply-draft-close"
                      onClick={() => {
                        setReplyingTo(null);
                        autoScrollRef.current = true;
                        requestAnimationFrame(() => {
                          smoothScrollToBottom(true, false);
                        });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : null}
                <textarea
                  ref={composerInputRef}
                  className="composer-input"
                  value={draft}
                  rows={1}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    startTyping();
                    resizeComposerTextarea();
                  }}
                  onPaste={handleComposerPaste}
                  onBlur={stopTyping}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder={pendingUploads.length ? 'Add a caption' : 'Type a message'}
                />
              </div>

              <div className="composer-actions">
                <button className="icon-btn small" onClick={sendAttachment}>
                  📎
                </button>
                <button className="icon-btn small" onClick={sendAttachment}>
                  🖼️
                </button>
                <button className="send-btn" onClick={sendMessage}>
                  ➤
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className="empty-state">Select a contact to start chatting</div>
        )}

        {isDragOver && selectedUser ? (
          <div className="chat-drop-overlay">
            <div className="chat-drop-card">
              <div className="chat-drop-icon">📎</div>
              <div className="chat-drop-title">Drop files to attach</div>
              <div className="chat-drop-subtitle">Add a caption, then press Send</div>
            </div>
          </div>
        ) : null}
      </main>

      {deleteChatTarget ? (
        <div className="call-overlay">
          <div className="call-modal" style={{ width: 'min(480px, calc(100% - 32px))' }}>
            <div className="call-top">
              <div>
                <div className="call-name">Delete chat</div>
                <div className="call-sub">Choose how to delete chat with {deleteChatTarget.name}</div>
              </div>
            </div>

            <div style={{ color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
              Delete for me hides the current chat only on your app.
              <br />
              Delete for everyone removes the chat history for both users.
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setDeleteChatTargetUserId(null)}>
                Cancel
              </button>
              <button className="icon-btn wide" onClick={clearCurrentConversationForMe}>
                Delete for me
              </button>
              <button className="danger wide" onClick={deleteCurrentConversationForEveryone}>
                Delete for everyone
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteMessageTarget ? (
        <div className="call-overlay">
          <div className="call-modal" style={{ width: 'min(480px, calc(100% - 32px))' }}>
            <div className="call-top">
              <div>
                <div className="call-name">Delete message</div>
                <div className="call-sub">
                  Choose how to delete this message
                </div>
              </div>
            </div>

            <div style={{ color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
              Delete for me hides this message only on your app.
              <br />
              {deleteMessageTarget.fromUserId === me.id
                ? 'Delete for everyone replaces the message for both users.'
                : 'You can delete this message for yourself.'}
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setDeleteMessageTargetId(null)}>
                Cancel
              </button>
              <button className="icon-btn wide" onClick={clearMessageForMe}>
                Delete for me
              </button>
              {deleteMessageTarget.fromUserId === me.id ? (
                <button className="danger wide" onClick={deleteMessageForEveryone}>
                  Delete for everyone
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {incomingFromUserId ? (
        <div className="incoming-box tg-incoming-call">
          <div className="tg-incoming-call-top">
            <div
              className="tg-incoming-avatar"
              style={{ background: avatarBg(incomingFromUserId) }}
            >
              {getInitials(userName(incomingFromUserId))}
            </div>

            <div
              className={`tg-incoming-badge ${
                incomingCallMode === 'audio' ? 'audio' : 'video'
              }`}
            >
              <span className="tg-incoming-badge-icon">
                {incomingCallMode === 'audio' ? '📞' : '🎥'}
              </span>
              <span>
                {incomingCallMode === 'audio' ? 'Voice call' : 'Video call'}
              </span>
            </div>
          </div>

          <div className="incoming-title">{userName(incomingFromUserId)}</div>
          <div className="incoming-body">
            {incomingCallMode === 'audio'
              ? 'Incoming voice call'
              : 'Incoming video call'}
          </div>

          <div className="incoming-actions">
            <button className="danger" onClick={declineCall}>
              Decline
            </button>
            <button className="success" onClick={acceptCall}>
              Accept
            </button>
          </div>
        </div>
      ) : null}

      {callState ? (
        <div className="call-overlay">
          <div className="call-modal">
            <div className="call-top">
              <div>
                <div className="call-name">{userName(callState.peerUserId)}</div>
                <div className="call-sub">{callStatus || callState.phase}</div>
              </div>
            </div>

            <div className="video-grid">
              {callState.mode === 'video' ? (
                <>
                  <div className="video-card large">
                    <video ref={remoteVideoRef} autoPlay playsInline />
                    {!remoteStreamState ? <div className="video-placeholder">Waiting for remote video…</div> : null}
                    <span className="video-label">Remote</span>
                  </div>

                  <div className="video-card smallcard">
                    <video ref={localVideoRef} autoPlay playsInline muted />
                    {!localStreamState ? <div className="video-placeholder">Starting camera…</div> : null}
                    <span className="video-label">You</span>
                  </div>
                </>
               ) : (
                <div className="video-card large">
                  <audio ref={remoteAudioRef} autoPlay playsInline />
                  <div className="video-placeholder">
                    {callState.phase === 'connected'
                      ? `Voice call with ${userName(callState.peerUserId)}`
                      : `Connecting voice call with ${userName(callState.peerUserId)}...`}
                  </div>
                  <span className="video-label">Voice call</span>
                </div>
              )}
            </div>

            <div className="call-actions">
              <button className="icon-btn wide" onClick={toggleMute}>
                {callState.muted ? 'Unmute' : 'Mute'}
              </button>

              {callState.mode === 'video' ? (
                <button className="icon-btn wide" onClick={toggleCamera}>
                  {callState.cameraOff ? 'Camera On' : 'Camera Off'}
                </button>
              ) : null}

              <button className="danger wide" onClick={() => cleanupCall(true)}>
                End call
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => startReply(contextMenu.messageId)}>
            Reply
          </button>

          <button
            className="context-menu-item danger"
            onClick={() => openDeleteMessageDialog(contextMenu.messageId)}
          >
            Delete message
          </button>
        </div>
      ) : null}
    </div>
  );
}