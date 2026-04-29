import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';

const FIXED_SERVER_URL = 'http://172.16.67.6:4000';

type User = {
  id: string;
  userId: string;
  name: string;
  avatarUrl?: string | null;
  role?: 'admin' | 'user';
  isApproved?: boolean;
  canLogin?: boolean;
  canAudioCall?: boolean;
  canVideoCall?: boolean;
  createdAt?: number;
};

type Attachment = {
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
};

type MentionState =
  | {
      start: number;
      end: number;
      query: string;
    }
  | null;

type GroupChat = {
  id: string;
  title: string;
  avatarUrl?: string | null;
  ownerUserId?: string | null;
  memberIds: string[];
  adminUserIds: string[];
  invitedUserIds: string[];
  joinRequestUserIds: string[];
  createdAt: number;
  updatedAt: number;
};

type GroupNotice = {
  id: string;
  kind: 'info' | 'deleted';
  groupId: string;
  title: string;
  message: string;
  createdAt: number;
};

type GroupInvite = {
  groupId: string;
  title: string;
  avatarUrl?: string | null;
  ownerUserId?: string | null;
  adminUserIds: string[];
  status: 'invited' | 'requested';
  createdAt: number;
};

type ReplyTo = {
  messageId: string;
  fromUserId: string;
  text: string;
  attachmentName: string | null;
  isImage: boolean;
};

type GroupConfirmDialog =
  | {
      mode: 'leave' | 'delete';
      groupId: string;
      title: string;
    }
  | null;

type ToastTone = 'info' | 'success' | 'error';

type AppToast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type AppNotification = {
  id: string;
  kind: 'login' | 'logout' | 'group';
  userId: string | null;
  userName: string;
  title: string;
  body: string;
  avatarUrl?: string | null;
  groupId?: string | null;
  createdAt: number;
};

type CallMode = 'audio' | 'video';

type Message = {
  id: string;
  conversationKey: string;
  groupId: string | null;
  fromUserId: string;
  toUserId: string | null;
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
  groupReadByUserIds: string[] | null;
};

type SidebarTab = 'chats' | 'calls' | 'notifications' | 'invitations';

type PendingUpload = {
  id: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  previewUrl: string | null;
};

type ContactListItem =
  | {
      kind: 'group';
      id: string;
      title: string;
      group: GroupChat;
      last?: Message;
      unreadCount: number;
      typingText: string;
      sortAt: number;
    }
  | {
      kind: 'direct';
      id: string;
      title: string;
      user: User;
      last?: Message;
      unreadCount: number;
      typingText: string;
      presence: 'online' | 'idle' | 'offline';
      selectedTogether: boolean;
      sortAt: number;
    };

type LightboxState =
  | {
      items: Attachment[];
      index: number;
    }
  | null;

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

function groupConversationKey(groupId: string) {
  return `group:${groupId}`;
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


function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadAttachment(attachment: Attachment, serverUrl: string) {
  const href = `${serverUrl}${attachment.url}`;

  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error('Download failed');

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = attachment.filename || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);
  } catch {
    const link = document.createElement('a');
    link.href = href;
    link.download = attachment.filename || 'download';
    link.target = '_blank';
    link.rel = 'noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

function AttachmentPreview({
  attachment,
  serverUrl,
  onOpenImage
}: {
  attachment: Attachment;
  serverUrl: string;
  onOpenImage: () => void;
}) {
  const href = `${serverUrl}${attachment.url}`;

  if (attachment.isImage) {
    return (
      <div className="image-attachment-wrap">
        <button
          type="button"
          className="media-reset-btn image-attachment-link"
          onClick={onOpenImage}
        >
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
        </button>

        <button
          type="button"
          className="attachment-download-btn"
          title="Download"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void downloadAttachment(attachment, serverUrl);
          }}
        >
          ⬇
        </button>
      </div>
    );
  }

  return (
    <div className="file-attachment-card">
      <div className="file-attachment-info">
        <div className="file-attachment-name">📄 {attachment.filename}</div>
        <div className="file-attachment-sub">
          {attachment.mimeType || 'File'} · {formatFileSize(attachment.size)}
        </div>
      </div>

      <div className="file-attachment-actions">
        <a
          className="file-action-btn"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          Open
        </a>

        <button
          type="button"
          className="file-action-btn"
          onClick={() => {
            void downloadAttachment(attachment, serverUrl);
          }}
        >
          Download
        </button>
      </div>
    </div>
  );
}

function GalleryPreview({
  attachments,
  serverUrl,
  onOpenImage
}: {
  attachments: Attachment[];
  serverUrl: string;
  onOpenImage: (index: number) => void;
}) {
  const visibleCount = attachments.length >= 5 ? 5 : attachments.length;
  const visible = attachments.slice(0, visibleCount);
  const extraCount = attachments.length - visibleCount;

  const layoutClass =
    visible.length >= 5
      ? 'layout-5plus'
      : visible.length === 4
      ? 'layout-4'
      : visible.length === 3
      ? 'layout-3'
      : 'layout-2';

  return (
    <div className={`gallery-attachment ${layoutClass}`}>
      {visible.map((item, index) => {
        const showOverlay = index === visible.length - 1 && extraCount > 0;

        return (
          <div
            key={`${item.url}_${index}`}
            className={`gallery-item item-${index + 1}`}
          >
            <button
              type="button"
              className="media-reset-btn gallery-item-link"
              onClick={() => onOpenImage(index)}
            >
              <img
                src={`${serverUrl}${item.url}`}
                alt={item.filename}
                className="gallery-item-image"
              />

              {showOverlay ? (
                <div className="gallery-more-overlay">+{extraCount}</div>
              ) : null}
            </button>

            <button
              type="button"
              className="gallery-download-btn"
              title="Download"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void downloadAttachment(item, serverUrl);
              }}
            >
              ⬇
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ImageLightbox({
  state,
  serverUrl,
  onClose,
  onPrev,
  onNext,
  onSelect
}: {
  state: LightboxState;
  serverUrl: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
}) {
  useEffect(() => {
    if (!state) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'ArrowLeft' && state.items.length > 1) {
        onPrev();
      } else if (event.key === 'ArrowRight' && state.items.length > 1) {
        onNext();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [state, onClose, onPrev, onNext]);

  if (!state) return null;

  const current = state.items[state.index];
  if (!current) return null;

  const hasMultiple = state.items.length > 1;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-topbar">
          <div className="lightbox-meta">
            <div className="lightbox-filename">{current.filename}</div>
            <div className="lightbox-counter">
              {state.index + 1} / {state.items.length}
            </div>
          </div>

          <div className="lightbox-actions">
            <button
              type="button"
              className="lightbox-action-btn"
              onClick={() => void downloadAttachment(current, serverUrl)}
              title="Download"
            >
              ⬇ Download
            </button>
            <button
              type="button"
              className="lightbox-action-btn"
              onClick={onClose}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="lightbox-stage">
          {hasMultiple ? (
            <button
              type="button"
              className="lightbox-nav prev"
              onClick={onPrev}
              aria-label="Previous image"
            >
              ‹
            </button>
          ) : null}

          <img
            src={`${serverUrl}${current.url}`}
            alt={current.filename}
            className="lightbox-image"
          />

          {hasMultiple ? (
            <button
              type="button"
              className="lightbox-nav next"
              onClick={onNext}
              aria-label="Next image"
            >
              ›
            </button>
          ) : null}
        </div>

        {hasMultiple ? (
          <div className="lightbox-thumb-row">
            {state.items.map((item, index) => (
              <button
                key={`${item.url}_${index}`}
                type="button"
                className={`media-reset-btn lightbox-thumb ${index === state.index ? 'active' : ''}`}
                onClick={() => onSelect(index)}
              >
                <img
                  src={`${serverUrl}${item.url}`}
                  alt={item.filename}
                  className="lightbox-thumb-image"
                />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  subtitle,
  children,
  onClose,
  onConfirm,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmClassName = 'danger wide',
  width = 'min(480px, calc(100% - 32px))',
  actions
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm?: () => void;
  confirmText?: string;
  cancelText?: string;
  confirmClassName?: string;
  width?: string;
  actions?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="call-overlay" onClick={onClose}>
      <div
        className="call-modal"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="call-top">
          <div>
            <div className="call-name">{title}</div>
            {subtitle ? <div className="call-sub">{subtitle}</div> : null}
          </div>
        </div>

        <div style={{ color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
          {children}
        </div>

        <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
          {actions ? (
            actions
          ) : (
            <>
              <button className="icon-btn wide" onClick={onClose}>
                {cancelText}
              </button>

              <button
                className={confirmClassName}
                onClick={() => {
                  onConfirm?.();
                }}
              >
                {confirmText}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UserAvatar({
  user,
  serverUrl,
  size = 'default'
}: {
  user: User;
  serverUrl: string;
  size?: 'default' | 'small' | 'large';
}) {
  const className =
    size === 'small' ? 'avatar small' : size === 'large' ? 'avatar large' : 'avatar';

  if (user.avatarUrl) {
    return (
      <img
        src={`${serverUrl}${user.avatarUrl}`}
        alt={user.name}
        className={`${className} avatar-image`}
      />
    );
  }

  return (
    <div className={className} style={{ background: avatarBg(user.id) }}>
      {getInitials(user.name || user.userId)}
    </div>
  );
}

function notificationText(item: AppNotification) {
  if (item.body) return item.body;

  if (item.kind === 'login') {
    return `${item.userName} logged in`;
  }

  if (item.kind === 'logout') {
    return `${item.userName} logged out`;
  }

  return item.title || 'Group update';
}

function playPresenceNotificationSound() {
  try {
    const AudioContextCtor =
      window.AudioContext || (window as any).webkitAudioContext;

    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.24);

    oscillator.onended = () => {
      void ctx.close().catch(() => undefined);
    };
  } catch {}
}

function getActiveMention(text: string, caret: number): MentionState {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const left = text.slice(0, safeCaret);

  const match = left.match(/(^|\s)@([a-zA-Z0-9._-]*)$/);
  if (!match) return null;

  const query = match[2] || '';
  const start = safeCaret - query.length - 1;

  return {
    start,
    end: safeCaret,
    query: query.toLowerCase()
  };
}

function getGroupRoleLabel(group: GroupChat | null, userId: string) {
  if (!group) return 'Member';
  if (group.ownerUserId === userId) return 'Owner';
  if (group.adminUserIds.includes(userId)) return 'Admin';
  return 'Member';
}

export default function App() {
  const storedToken = localStorage.getItem('lan_chat_auth_token') || '';

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loginUserId, setLoginUserId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authToken, setAuthToken] = useState(storedToken);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  const [adminOpen, setAdminOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<User[]>([]);
  const [appInfo, setAppInfo] = useState<{ platform: string; appVersion: string } | null>(null);

  const [connectedServerUrl, setConnectedServerUrl] = useState(FIXED_SERVER_URL);
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
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>('chats');

  const [groupInvites, setGroupInvites] = useState<GroupInvite[]>([]);
  const [groupManageOpen, setGroupManageOpen] = useState(false);

  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [selectedChatKind, setSelectedChatKind] = useState<'direct' | 'group'>('direct');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [groupTypingByChat, setGroupTypingByChat] = useState<Record<string, string[]>>({});

  const groupsRef = useRef<GroupChat[]>([]);
  const selectedGroupIdRef = useRef('');
  const selectedChatKindRef = useRef<'direct' | 'group'>('direct');

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
  const [lightbox, setLightbox] = useState<LightboxState>(null);  
  const meRef = useRef<User | null>(null);
  const localStreamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [adminSearch, setAdminSearch] = useState('');
  const suppressAutoReadUntilBottomRef = useRef(false);
  const hasUserScrolledCurrentChatRef = useRef(false);
  const [activeChatTargets, setActiveChatTargets] = useState<Record<string, string | null>>({});
  const [hasExplicitContactSelection, setHasExplicitContactSelection] = useState(false);
  const [isSocketAuthed, setIsSocketAuthed] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const activeSidebarTabRef = useRef<SidebarTab>('chats');
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
  const sidebarMenuRef = useRef<HTMLDivElement | null>(null);
  const [groupManageTab, setGroupManageTab] = useState<'general' | 'members'>('general');
  const [groupEditTitle, setGroupEditTitle] = useState('');
  const [groupConfirmDialog, setGroupConfirmDialog] = useState<GroupConfirmDialog>(null);

  const [groupMembersOpen, setGroupMembersOpen] = useState(false);
  const [groupMemberSearch, setGroupMemberSearch] = useState('');
  const [mentionState, setMentionState] = useState<MentionState>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [deleteGroupChatTargetId, setDeleteGroupChatTargetId] = useState<string | null>(null);
  const deleteGroupChatTarget =
    groups.find((g) => g.id === deleteGroupChatTargetId) || null;

  const desktopApi = window.desktop ?? {
    getConfig: async () => ({
      platform: 'web',
      appVersion: 'browser'
    }),
    notify: async (_opts: { title: string; body: string; userId?: string; kind?: 'message' | 'call' }) => {},
    onOpenFileDialog: async () => [],
    onNavigateToChat: (_callback: (payload: { userId: string; kind: 'message' | 'call' }) => void) => () => {},
    setBadgeCount: async (_count: number) => {}
  };

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    currentCallRef.current = callState;
  }, [callState]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  
  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);
  
  useEffect(() => {
    selectedChatKindRef.current = selectedChatKind;
  }, [selectedChatKind]);

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
    activeSidebarTabRef.current = activeSidebarTab;
  }, [activeSidebarTab]);

  useEffect(() => {
    if (!groupManageOpen) {
      setGroupConfirmDialog(null);
    }
  }, [groupManageOpen]);
  
  useEffect(() => {
    setGroupConfirmDialog(null);
  }, [selectedGroupId]);

  useEffect(() => {
    setReplyingTo(null);
    setDeleteChatTargetUserId(null);
    setDeleteGroupChatTargetId(null);
    setDeleteMessageTargetId(null);
    setIncomingCallMode(null);
    incomingCallModeRef.current = null;
    clearPendingUploads();
    setLightbox(null);
    setGroupMembersOpen(false);
    setGroupMemberSearch('');
    setMentionState(null);
    setMentionActiveIndex(0);
  
    suppressAutoReadUntilBottomRef.current = false;
    hasUserScrolledCurrentChatRef.current = false;
  }, [selectedUserId, selectedGroupId, selectedChatKind]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!sidebarMenuRef.current) return;
  
      if (!sidebarMenuRef.current.contains(event.target as Node)) {
        setSidebarMenuOpen(false);
      }
    }
  
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSidebarMenuOpen(false);
      }
    }
  
    window.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleEscape);
  
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  useEffect(() => {
    if (activeSidebarTab === 'notifications') {
      setUnreadNotificationCount(0);
    }
  }, [activeSidebarTab]);
  
  useEffect(() => {
    return () => {
      pendingUploadsRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    if (!socketRef.current || !me || !isSocketAuthed) return;

    socketRef.current.emit('chat:selected-peer', {
      selectedPeerUserId:
        isWindowActive &&
        selectedChatKind === 'direct' &&
        selectedUserId
          ? selectedUserId
          : null,
      isWindowActive
    });
  }, [me, isSocketAuthed, selectedUserId, selectedChatKind, isWindowActive]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
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
      setSelectedChatKind('direct');
      setSelectedGroupId('');
      setHasExplicitContactSelection(false);
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

  async function handleRegister() {
    if (!loginUserId.trim()) {
      showError('Enter user ID');
      return;
    }
  
    if (!password.trim()) {
      showError('Enter password');
      return;
    }
  
    if (password !== confirmPassword) {
      showError('Passwords do not match');
      return;
    }
  
    const res = await fetch(`${FIXED_SERVER_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: loginUserId.trim(),
        password
      })
    });
  
    const data = await res.json();
  
    if (!res.ok) {
      showError(data.error || 'Registration failed');
      return;
    }
  
    showSuccess(data.message || 'Registered successfully');
    setAuthMode('login');
    setPassword('');
    setConfirmPassword('');
  }
  
  async function handleLogin() {
    const res = await fetch(`${FIXED_SERVER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: loginUserId.trim(),
        password
      })
    });
  
    const loginData = await res.json();
  
    if (!res.ok) {
      showError(loginData.error || 'Login failed');
      return;
    }
  
    localStorage.setItem('lan_chat_auth_token', loginData.token);

    setAuthToken(loginData.token);
    setConnectedServerUrl(FIXED_SERVER_URL);
    setMe(loginData.user);
    meRef.current = loginData.user;
    setUsers(loginData.users || []);
    setGroups(loginData.groups || []);
    setOnlineUserIds(loginData.onlineUserIds || []);
    setIdleUserIds(loginData.idleUserIds || []);
    setProfileName(loginData.user.name || '');
    setActiveChatTargets(loginData.activeChatTargets || {});
    setHasExplicitContactSelection(false);
    setNotifications(loginData.notifications || []);
    setGroupInvites(loginData.groupInvites || []);

    setIsSocketAuthed(false);
    setSelectedChatKind('direct');
    setSelectedUserId('');
    setSelectedGroupId('');
    setActiveSidebarTab('chats');
    setUnreadNotificationCount(0);
  
    socketRef.current?.disconnect();
  
    const socket = io(FIXED_SERVER_URL, { transports: ['websocket'] });
    socketRef.current = socket;
  
    socket.on('connect', () => {
      socket.emit('auth:join', { token: loginData.token }, async (payload: any) => {
        if (!payload?.ok) {
          showError(payload?.error || 'Socket login failed');
          socket.disconnect();
          return;
        }

        setIsSocketAuthed(true);  
        setUsers(payload.users || []);
        setGroups(payload.groups || []);
        setOnlineUserIds(payload.onlineUserIds || []);
        setIdleUserIds(payload.idleUserIds || []);
        setActiveChatTargets(payload.activeChatTargets || {});
        setHasExplicitContactSelection(false);
        setNotifications(payload.notifications || []);
        setGroupInvites(payload.groupInvites || []);

        const historyMap = await loadAllHistories(
          payload.users || [],
          loginData.token,
          payload.groups || []
        );
        
        const preferredDirect = pickPreferredDirectUserId({
          meId: loginData.user.id,
          users: payload.users || [],
          onlineUserIds: payload.onlineUserIds || [],
          idleUserIds: payload.idleUserIds || [],
          historyMap
        });
        
        const fallbackGroup = payload.groups?.[0]?.id || '';
        
        if (preferredDirect) {
          setSelectedChatKind('direct');
          setSelectedGroupId('');
          setSelectedUserId(preferredDirect);
        } else if (fallbackGroup) {
          setSelectedChatKind('group');
          setSelectedUserId('');
          setSelectedGroupId(fallbackGroup);
        } else {
          setSelectedChatKind('direct');
          setSelectedUserId('');
          setSelectedGroupId('');
        }
  
        showSuccess(`Welcome, ${loginData.user.name || loginData.user.userId}!`);
      });
    });
  
    socket.on('auth:revoked', ({ reason }: { reason?: string }) => {
      showError(reason || 'Your session was revoked by admin');
      localStorage.removeItem('lan_chat_auth_token');
      socket.disconnect();
      setActiveChatTargets({});
      setHasExplicitContactSelection(false);
      setIsSocketAuthed(false);
      setSelectedUserId('');
      setSelectedGroupId('');
      setSelectedChatKind('direct');
      setMe(null);
      meRef.current = null;
      setAuthToken('');
      setNotifications([]);
      setGroupInvites([]);
      setUnreadNotificationCount(0);
      setActiveSidebarTab('chats');
    });
  
    socket.on(
      'message:status',
      ({
        messageId,
        deliveredAt,
        readAt
      }: {
        messageId: string;
        deliveredAt: number | null;
        readAt: number | null;
      }) => {
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
  
    socket.on(
      'chat:active-map',
      ({ activeChatTargets }: { activeChatTargets?: Record<string, string | null> }) => {
        setActiveChatTargets(activeChatTargets || {});
      }
    );

    socket.on('group:notice', (notice: GroupNotice) => {
      const isCurrentGroup =
        selectedChatKindRef.current === 'group' &&
        selectedGroupIdRef.current === notice.groupId;
    
      if (!isCurrentGroup || notice.kind === 'deleted') {
        showToast(notice.message, 'info', 3600);
      }
    
      if (!isWindowActiveRef.current || !isCurrentGroup) {
        desktopApi.notify({
          title: notice.title || 'Group update',
          body: notice.message
        });
      }
    
      if (notice.kind === 'deleted') {
        setGroupManageOpen(false);
        setGroupConfirmDialog(null);
      }
    });
  
    socket.on('users:changed', () => {
      socket.emit(
        'users:sync',
        async (payload: {
          users: User[];
          onlineUserIds: string[];
          idleUserIds: string[];
          activeChatTargets?: Record<string, string | null>;
          groups?: GroupChat[];
          groupInvites?: GroupInvite[];
        }) => {
          setUsers(payload.users || []);
          setGroups(payload.groups || []);
          setOnlineUserIds(payload.onlineUserIds || []);
          setIdleUserIds(payload.idleUserIds || []);
          setActiveChatTargets(payload.activeChatTargets || {});
          setGroupInvites(payload.groupInvites || []);
  
          const historyMap = await loadAllHistories(
            payload.users || [],
            undefined,
            payload.groups || []
          );
          
          const fallbackDirect = pickPreferredDirectUserId({
            meId: loginData.user.id,
            users: payload.users || [],
            onlineUserIds: payload.onlineUserIds || [],
            idleUserIds: payload.idleUserIds || [],
            historyMap
          });
          
          const fallbackGroup = payload.groups?.[0]?.id || '';
          
          setSelectedUserId((curr) => {
            if (selectedChatKindRef.current !== 'direct') return curr;
            const stillExists = payload.users.some((u: User) => u.id === curr);
            return stillExists ? curr : fallbackDirect;
          });
          
          setSelectedGroupId((curr) => {
            if (selectedChatKindRef.current !== 'group') return curr;
            const stillExists = (payload.groups || []).some((g: GroupChat) => g.id === curr);
            return stillExists ? curr : fallbackGroup;
          });
        }
      );
    });
  
    socket.on(
      'group:read:update',
      ({
        groupId,
        userId,
        messageIds
      }: {
        groupId: string;
        userId: string;
        messageIds: string[];
      }) => {
        applyGroupReadUpdate(groupId, userId, messageIds);
      }
    );

    socket.on(
      'presence:update',
      (payload: { onlineUserIds: string[]; idleUserIds: string[] }) => {
        setOnlineUserIds(payload.onlineUserIds || []);
        setIdleUserIds(payload.idleUserIds || []);
      }
    );
    
    socket.on('notification:new', (item: AppNotification) => {
      if (item.kind !== 'group' && item.userId === loginData.user.id) return;
    
      setNotifications((prev) => [item, ...prev].slice(0, 200));
    
      if (item.kind === 'login' || item.kind === 'logout') {
        playPresenceNotificationSound();
      }
    
      showToast(notificationText(item), 'info', 3200);
    
      if (activeSidebarTabRef.current !== 'notifications') {
        setUnreadNotificationCount((prev) => prev + 1);
      }
    });
  
    socket.on('message:new', (message: Message) => {
      setMessagesByConv((prev) => {
        const key = message.groupId
          ? groupConversationKey(message.groupId)
          : message.conversationKey;
        const next = [...(prev[key] || []), message];
        return { ...prev, [key]: next };
      });

      if (
        message.groupId &&
        message.fromUserId !== loginData.user.id &&
        selectedChatKindRef.current === 'group' &&
        selectedGroupIdRef.current === message.groupId &&
        isWindowActiveRef.current &&
        isMessagesNearBottom()
      ) {
        markUnreadGroupMessagesAsRead(message.groupId, [...activeMessagesRef.current, message]);
      }
  
      const isNormalNotifyMessage = ['text', 'file', 'gallery'].includes(message.type);

      if (message.fromUserId !== loginData.user.id && isNormalNotifyMessage) {
        const senderName =
          usersRef.current.find((u) => u.id === message.fromUserId)?.name || 'New message';
        const attachments = getMessageAttachments(message);

        const bodyText = isGalleryMessage(message)
          ? `${senderName} sent ${attachments.length} photos${message.text ? `: ${message.text}` : ''}`
          : message.type === 'file'
          ? `${senderName} sent ${attachments[0]?.isImage ? 'an image' : 'a file'}: ${attachments[0]?.filename || ''}`
          : message.text;

        if (message.groupId) {
          const groupName =
            groupsRef.current.find((g) => g.id === message.groupId)?.title || 'Group';

          desktopApi.notify({
            title: groupName,
            body: `${senderName}: ${bodyText}`
          });
        } else {
          desktopApi.notify({
            title: senderName,
            body: bodyText,
            userId: message.fromUserId,
            kind: 'message'
          });
        }
      }

      if (!message.groupId && message.toUserId === loginData.user.id) {
        socket.emit('message:delivered', {
          messageId: message.id,
          byUserId: loginData.user.id
        });

        const shouldAffectUnread = isUnreadAffectingMessage(message, loginData.user.id);

        if (!shouldAffectUnread || canMarkConversationAsRead(message.fromUserId)) {
          socket.emit('message:read', {
            messageId: message.id,
            byUserId: loginData.user.id
          });
        }
      }
    });

    socket.on(
      'group:conversation:cleared-for-me',
      ({
        conversationKey: clearedConversationKey
      }: {
        groupId: string;
        conversationKey: string;
        userId: string;
        clearedAt: number;
      }) => {
        clearConversationLocally(clearedConversationKey);
        setDeleteGroupChatTargetId(null);
      }
    );
    
    socket.on(
      'group:conversation:deleted',
      ({
        conversationKey: deletedConversationKey,
        byUserId
      }: {
        groupId: string;
        conversationKey: string;
        byUserId: string;
      }) => {
        clearConversationLocally(deletedConversationKey);
        setDeleteGroupChatTargetId(null);
    
        if (byUserId !== meRef.current?.id) {
          showToast(`${userNameFromList(byUserId, usersRef.current)} cleared the group chat`, 'info', 3200);
        }
      }
    );
  
    socket.on('message:deleted', (message: Message) => {
      setMessagesByConv((prev) => {
        const key = message.conversationKey;
        const next = (prev[key] || []).map((m) => (m.id === message.id ? message : m));
        return { ...prev, [key]: next };
      });
    });
  
    socket.on(
      'typing:update',
      ({
        fromUserId,
        groupId,
        isTyping
      }: {
        fromUserId: string;
        groupId?: string | null;
        isTyping: boolean;
      }) => {
        if (groupId) {
          const key = groupConversationKey(groupId);
    
          setGroupTypingByChat((prev) => {
            const existing = prev[key] || [];
            const next = isTyping
              ? existing.includes(fromUserId)
                ? existing
                : [...existing, fromUserId]
              : existing.filter((id) => id !== fromUserId);
    
            return { ...prev, [key]: next };
          });
    
          return;
        }
    
        setTypingFrom((prev) => ({ ...prev, [fromUserId]: isTyping }));
      }
    );
  
    socket.on('call:invite', ({ fromUserId, mode }: { fromUserId: string; mode?: CallMode }) => {
      const callMode = mode === 'audio' ? 'audio' : 'video';
  
      incomingFromUserIdRef.current = fromUserId;
      incomingCallModeRef.current = callMode;
  
      setIncomingFromUserId(fromUserId);
      setIncomingCallMode(callMode);
  
      const senderName =
        usersRef.current.find((u) => u.id === fromUserId)?.name || 'Incoming call';
  
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
  
    socket.on(
      'call:accepted',
      async ({ fromUserId, mode }: { fromUserId: string; mode?: CallMode }) => {
        if (currentCallRef.current?.peerUserId !== fromUserId) return;
  
        try {
          const callMode = currentCallRef.current?.mode || mode || 'video';
  
          setCallState((prev) =>
            prev ? { ...prev, phase: 'connecting', mode: callMode } : prev
          );
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
        } catch (error) {
          const callMode = currentCallRef.current?.mode || mode || 'video';
          const message = getCallDeviceErrorMessage(error, callMode);
          setCallStatus(message);
          showToast(message, 'error', 4200);
          cleanupCall(false);
        }
      }
    );
  
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
        data: signalData
      }: {
        fromUserId: string;
        data: { type: 'offer' | 'answer' | 'candidate'; payload: any };
      }) => {
        try {
          if (signalData.type === 'offer') {
            const callMode =
              currentCallRef.current?.mode || incomingCallModeRef.current || 'video';
  
            const stream = await ensureLocalStream(callMode);
            const peer = createPeer(fromUserId, stream);
            await peer.setRemoteDescription(
              new RTCSessionDescription(signalData.payload)
            );
  
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
  
          if (signalData.type === 'answer' && peerRef.current) {
            await peerRef.current.setRemoteDescription(
              new RTCSessionDescription(signalData.payload)
            );
          }
  
          if (signalData.type === 'candidate' && peerRef.current) {
            await peerRef.current.addIceCandidate(
              new RTCIceCandidate(signalData.payload)
            );
          }
        } catch (error) {
          console.error('signal failure', error);
          const message = 'Unable to establish the local connection.';
          setCallStatus(message);
          showToast(message, 'error', 4200);
          cleanupCall(false);
        }
      }
    );
  }

  async function handleLogout() {
    setSidebarMenuOpen(false);
  
    try {
      await flushCurrentGroupReadBeforeLogout();
    } catch {}
  
    try {
      await apiFetch('/api/logout', { method: 'POST' });
    } catch {}
  
    cleanupCall(true);
    socketRef.current?.disconnect();
    localStorage.removeItem('lan_chat_auth_token');
    meRef.current = null;
    setActiveChatTargets({});
    setHasExplicitContactSelection(false);
    setMessagesByConv({});
    setNotifications([]);
    setGroupInvites([]);
    setUnreadNotificationCount(0);
    setActiveSidebarTab('chats');
    setMe(null);
    setAuthToken('');
    setIsSocketAuthed(false);
    setSelectedUserId('');
    setSelectedGroupId('');
    setSelectedChatKind('direct');
  }

  async function inviteUserToGroup(groupId: string, userId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to invite user');
      return;
    }
  
    if (data.requiresOwnerApproval) {
      showSuccess('Invitation sent. Owner approval will be required after acceptance.');
    } else {
      showSuccess('Invitation sent. User can join immediately after acceptance.');
    }
  }
  
  async function acceptGroupInvite(groupId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/invite/accept`, {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to accept invite');
      return;
    }
  
    setGroupInvites((prev) => prev.filter((item) => item.groupId !== groupId));
  
    if (data.joinedDirectly) {
      showSuccess('Invitation accepted. You joined the group.');
    } else {
      showSuccess('Invitation accepted. Waiting for owner approval.');
    }
  }
  
  async function declineGroupInvite(groupId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/invite/decline`, {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to decline invite');
      return;
    }
  
    setGroupInvites((prev) => prev.filter((item) => item.groupId !== groupId));
    showSuccess('Invitation declined');
  }
  
  async function approveGroupJoinRequest(groupId: string, userId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/requests/${userId}/approve`, {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to approve user');
      return;
    }
  
    showSuccess('User added to group');
  }
  
  async function rejectGroupJoinRequest(groupId: string, userId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/requests/${userId}/reject`, {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to reject request');
      return;
    }
  
    showSuccess('Request rejected');
  }
  
  async function setUserAdminRole(groupId: string, userId: string, makeAdmin: boolean) {
    const res = await apiFetch(`/api/groups/${groupId}/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, makeAdmin })
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to update role');
      return;
    }
  
    showSuccess(makeAdmin ? 'User promoted to group admin' : 'Admin role removed');
  }

  function deleteOwnGroupMessagesForEveryone() {
    if (!socketRef.current || !me || !deleteGroupChatTarget) return;
  
    socketRef.current.emit(
      'group:messages:delete-own',
      {
        groupId: deleteGroupChatTarget.id
      },
      (result: { ok: boolean; error?: string; deletedCount?: number }) => {
        if (!result?.ok) {
          showError(result?.error || 'Failed to delete your messages for everyone');
          return;
        }
  
        setDeleteGroupChatTargetId(null);
  
        showSuccess(
          result.deletedCount
            ? `${result.deletedCount} message${result.deletedCount > 1 ? 's were' : ' was'} deleted for everyone`
            : 'You have no messages to delete in this group'
        );
      }
    );
  }

  function clearGroupChatForEveryone() {
    if (!socketRef.current || !me || !deleteGroupChatTarget) return;
  
    socketRef.current.emit(
      'group:conversation:delete',
      {
        groupId: deleteGroupChatTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          showError(result?.error || 'Failed to clear group chat for everyone');
          return;
        }
  
        setDeleteGroupChatTargetId(null);
        showSuccess('Group chat cleared for everyone');
      }
    );
  }
  
  async function removeGroupMember(groupId: string, userId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/members/${userId}`, {
      method: 'DELETE'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to remove member');
      return;
    }
  
    showSuccess('Member removed');
  }

  function removeGroupConversationLocally(groupId: string) {
    const key = groupConversationKey(groupId);
  
    setMessagesByConv((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  
  function moveAwayFromGroup(groupId: string) {
    if (!me) return;
  
    const remainingGroups = groups.filter((group) => group.id !== groupId);
    const fallbackDirect = pickPreferredDirectUserId({
      meId: me.id,
      users,
      onlineUserIds,
      idleUserIds,
      historyMap: messagesByConv
    });
  
    if (selectedChatKind === 'group' && selectedGroupId === groupId) {
      if (remainingGroups.length) {
        setSelectedChatKind('group');
        setSelectedGroupId(remainingGroups[0].id);
        setSelectedUserId('');
        return;
      }
  
      if (fallbackDirect) {
        setSelectedChatKind('direct');
        setSelectedUserId(fallbackDirect);
        setSelectedGroupId('');
        return;
      }
  
      setSelectedChatKind('direct');
      setSelectedUserId('');
      setSelectedGroupId('');
    }
  }
  
  async function leaveGroup(groupId: string) {
    const res = await apiFetch(`/api/groups/${groupId}/leave`, {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to leave group');
      return;
    }
  
    setGroupManageOpen(false);
    setGroups((prev) => prev.filter((group) => group.id !== groupId));
    removeGroupConversationLocally(groupId);
    moveAwayFromGroup(groupId);
  
    showSuccess('You left the group');
  }
  
  async function deleteGroup(groupId: string) {
    const res = await apiFetch(`/api/groups/${groupId}`, {
      method: 'DELETE'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to delete group');
      return;
    }
  
    setGroupManageOpen(false);
    setGroups((prev) => prev.filter((group) => group.id !== groupId));
    removeGroupConversationLocally(groupId);
    moveAwayFromGroup(groupId);
  
    showSuccess('Group deleted');
  }

  async function confirmGroupDangerAction() {
    if (!groupConfirmDialog) return;
  
    const { mode, groupId } = groupConfirmDialog;
    setGroupConfirmDialog(null);
  
    if (mode === 'leave') {
      await leaveGroup(groupId);
      return;
    }
  
    await deleteGroup(groupId);
  }
  
  async function uploadGroupAvatar(groupId: string, file: File) {
    const form = new FormData();
    form.append('avatar', file);
  
    const res = await apiFetch(`/api/groups/${groupId}/avatar`, {
      method: 'POST',
      body: form
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to upload group avatar');
      return;
    }
  
    showSuccess('Group avatar updated');
  }

  function getRenderableUser(userId: string): User {
    return (
      users.find((u) => u.id === userId) || {
        id: userId,
        userId,
        name: userName(userId),
        avatarUrl: null,
        role: 'user',
        canAudioCall: true,
        canVideoCall: true
      }
    );
  }

  function handleSelectContact(userId: string) {
    stopTyping();
    setSelectedChatKind('direct');
    setSelectedGroupId('');
    setHasExplicitContactSelection(true);
    setSelectedUserId(userId);
  }

  const filteredAdminUsers = useMemo(() => {
    const q = adminSearch.trim().toLowerCase();
    if (!q) return adminUsers;
  
    return adminUsers.filter((user) => {
      return (
        user.name.toLowerCase().includes(q) ||
        user.userId.toLowerCase().includes(q)
      );
    });
  }, [adminUsers, adminSearch]);

  const allCallHistory = useMemo(() => {
    if (!me) return [] as Array<{
      message: Message;
      peerUserId: string;
      peer: User | null;
    }>;
  
    return Object.values(messagesByConv)
      .flat()
      .filter((message) => message.type === 'call')
      .map((message) => {
        const peerUserId =
          message.fromUserId === me.id ? message.toUserId : message.fromUserId;
  
        return {
          message,
          peerUserId,
          peer: users.find((u) => u.id === peerUserId) || null
        };
      })
      .sort((a, b) => b.message.createdAt - a.message.createdAt);
  }, [messagesByConv, users, me]);
  
  const invitationCount = useMemo(() => {
    return groupInvites.filter((item) => item.status === 'invited').length;
  }, [groupInvites]);

  function createPeer(remoteUserId: string, stream: MediaStream) {
    if (peerRef.current) return peerRef.current;
  
    const socket = socketRef.current;
    const currentMe = meRef.current;
  
    if (!socket) {
      throw new Error('Socket not ready');
    }
  
    if (!currentMe) {
      throw new Error('Current user not ready');
    }
  
    const peer = new RTCPeerConnection();
  
    stream.getTracks().forEach((track) => {
      peer.addTrack(track, stream);
    });
  
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          fromUserId: currentMe.id,
          toUserId: remoteUserId,
          data: { type: 'candidate', payload: event.candidate }
        });
      }
    };
  
    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      setRemoteStreamState(remoteStream);
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

  function getGroupById(groupId: string) {
    return groups.find((group) => group.id === groupId) || null;
  }
  
  function getGroupDisplayName(groupId: string) {
    return getGroupById(groupId)?.title || 'Group';
  }
  
  function getSelectedMessagesKey() {
    if (!me) return '';
    if (selectedChatKind === 'group' && selectedGroupId) {
      return groupConversationKey(selectedGroupId);
    }
    if (selectedChatKind === 'direct' && selectedUserId) {
      return conversationKey(me.id, selectedUserId);
    }
    return '';
  }
  
  function handleSelectGroup(groupId: string) {
    stopTyping();
    setSelectedChatKind('group');
    setSelectedUserId('');
    setSelectedGroupId(groupId);
    setHasExplicitContactSelection(false);
  }
  
  function toggleGroupMember(userId: string) {
    setGroupMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  function isUserSelectingMe(userId: string) {
    return !!me && activeChatTargets[userId] === me.id;
  }
  
  function isSelectedTogether(userId: string) {
    return !!me && selectedUserId === userId && activeChatTargets[userId] === me.id;
  }

  function isImageFileType(mimeType?: string, fileName?: string) {
    const type = String(mimeType || '').toLowerCase();
    if (type.startsWith('image/')) return true;
  
    const ext = String(fileName || '')
      .split('.')
      .pop()
      ?.toLowerCase();
  
    return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext || '');
  }

  function isUnreadAffectingMessage(message: Message, meId: string) {
    if (message.type === 'text' || message.type === 'file' || message.type === 'gallery') {
      return true;
    }
  
    // Count only missed incoming calls as unread
    if (message.type === 'call') {
      return message.fromUserId !== meId && message.call?.status === 'unanswered';
    }
  
    return false;
  }
  
  function isMessageStatusVisible(message: Message) {
    return !message.groupId && (message.type === 'text' || message.type === 'file' || message.type === 'gallery');
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
  
    const isImage = isImageFileType(mimeType, input.fileName);
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
  
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === 'video'
    });
  
    localStreamRef.current = stream;
    setLocalStreamState(stream);
    return stream;
  }

  function cleanupCall(notifyPeer: boolean) {
    const peerUserId =
      currentCallRef.current?.peerUserId ||
      callState?.peerUserId ||
      incomingFromUserIdRef.current;
  
    const currentMe = meRef.current;
  
    if (notifyPeer && peerUserId && socketRef.current && currentMe) {
      socketRef.current.emit('call:end', {
        fromUserId: currentMe.id,
        toUserId: peerUserId
      });
    }
  
    peerRef.current?.close();
    peerRef.current = null;
  
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }
  
    localStreamRef.current = null;
    localStreamPromiseRef.current = null;
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

  function getUnreadIncomingGroupMessages(groupId: string, sourceMessages: Message[]) {
    if (!me) return [];
  
    return sourceMessages.filter(
      (m) =>
        m.groupId === groupId &&
        m.fromUserId !== me.id &&
        isUnreadAffectingMessage(m, me.id) &&
        !(m.groupReadByUserIds || []).includes(me.id)
    );
  }
  
  function applyGroupReadUpdate(groupId: string, userId: string, messageIds: string[]) {
    if (!messageIds.length) return;
  
    setMessagesByConv((prev) => {
      const key = groupConversationKey(groupId);
      const current = prev[key] || [];
  
      return {
        ...prev,
        [key]: current.map((m) =>
          messageIds.includes(m.id)
            ? {
                ...m,
                groupReadByUserIds: Array.from(
                  new Set([...(m.groupReadByUserIds || []), userId])
                )
              }
            : m
        )
      };
    });
  }
    
  function markUnreadGroupMessagesAsRead(groupId: string, sourceMessages: Message[]) {
    if (!socketRef.current || !me) return;
    if (!isWindowActiveRef.current || !isMessagesNearBottom()) return;
  
    const unreadMessages = getUnreadIncomingGroupMessages(groupId, sourceMessages);
    if (!unreadMessages.length) return;
  
    const messageIds = unreadMessages.map((m) => m.id);
  
    socketRef.current.emit(
      'group:read',
      { groupId, messageIds },
      (result: { ok?: boolean; error?: string; messageIds?: string[] }) => {
        if (!result?.ok) return;
  
        const confirmedIds =
          result.messageIds && result.messageIds.length > 0
            ? result.messageIds
            : messageIds;
  
        applyGroupReadUpdate(groupId, me.id, confirmedIds);
      }
    );
  }

  async function flushCurrentGroupReadBeforeLogout() {
    if (
      !socketRef.current ||
      !meRef.current ||
      selectedChatKindRef.current !== 'group' ||
      !selectedGroupIdRef.current ||
      !isMessagesNearBottom()
    ) {
      return;
    }
  
    const unreadMessages = getUnreadIncomingGroupMessages(
      selectedGroupIdRef.current,
      activeMessagesRef.current
    );
  
    if (!unreadMessages.length) return;
  
    await new Promise<void>((resolve) => {
      socketRef.current?.emit(
        'group:read',
        {
          groupId: selectedGroupIdRef.current,
          messageIds: unreadMessages.map((m) => m.id)
        },
        (result: { ok?: boolean; messageIds?: string[] }) => {
          if (result?.ok) {
            const confirmedIds =
              result.messageIds && result.messageIds.length > 0
                ? result.messageIds
                : unreadMessages.map((m) => m.id);
  
            applyGroupReadUpdate(
              selectedGroupIdRef.current,
              meRef.current!.id,
              confirmedIds
            );
          }
  
          resolve();
        }
      );
    });
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

  function registerManualMessageScroll() {
    hasUserScrolledCurrentChatRef.current = true;
  }

  async function updateGroupTitle(groupId: string, title: string) {
    const trimmed = title.trim();
  
    if (!trimmed) {
      showError('Group name is required');
      return;
    }
  
    const res = await apiFetch(`/api/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed })
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to update group name');
      return;
    }
  
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId ? { ...group, ...data.group } : group
      )
    );
  
    showSuccess('Group name updated');
  }

  async function loadHistory(peerUserId: string, forceScroll = false) {
    if (!connectedServerUrl || !me) return;
  
    const res = await apiFetch(`/api/messages/${me.id}/${peerUserId}`);
    const data = await res.json();
  
    if (!res.ok) {
      showError(data.error || 'Failed to load messages');
      return;
    }
  
    setMessagesByConv((prev) => ({
      ...prev,
      [conversationKey(me.id, peerUserId)]: data.messages || []
    }));
  
    if (forceScroll) {
      autoScrollRef.current = true;
      smoothScrollToBottom(true, false);
    }
  }

  async function loadGroupHistory(groupId: string, forceScroll = false) {
    if (!connectedServerUrl || !me || !groupId) return;
  
    const res = await apiFetch(`/api/groups/${groupId}/messages`);
    const data = await res.json();
  
    if (!res.ok) {
      showError(data.error || 'Failed to load group messages');
      return;
    }
  
    setMessagesByConv((prev) => ({
      ...prev,
      [groupConversationKey(groupId)]: data.messages || []
    }));
  
    if (forceScroll) {
      autoScrollRef.current = true;
      smoothScrollToBottom(true, false);
    }
  }

  async function loadAllHistories(
    userList: User[],
    tokenOverride?: string,
    groupListOverride?: GroupChat[]
  ) {
    const currentMe = meRef.current;
    if (!currentMe) return {} as Record<string, Message[]>;
  
    const peers = userList.filter((u) => u.id !== currentMe.id);
    const groupList = groupListOverride ?? groupsRef.current ?? [];
  
    const directEntries = await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await apiFetch(
            `/api/messages/${currentMe.id}/${peer.id}`,
            {},
            tokenOverride
          );
          const data = await res.json().catch(() => ({}));
  
          if (!res.ok) {
            return [conversationKey(currentMe.id, peer.id), []] as const;
          }
  
          return [conversationKey(currentMe.id, peer.id), data.messages || []] as const;
        } catch {
          return [conversationKey(currentMe.id, peer.id), []] as const;
        }
      })
    );
  
    const groupEntries = await Promise.all(
      groupList.map(async (group) => {
        try {
          const res = await apiFetch(`/api/groups/${group.id}/messages`, {}, tokenOverride);
          const data = await res.json().catch(() => ({}));
  
          if (!res.ok) {
            return [groupConversationKey(group.id), []] as const;
          }
  
          return [groupConversationKey(group.id), data.messages || []] as const;
        } catch {
          return [groupConversationKey(group.id), []] as const;
        }
      })
    );
  
    const nextHistoryMap = Object.fromEntries([
      ...directEntries,
      ...groupEntries
    ]) as Record<string, Message[]>;
  
    setMessagesByConv((prev) => ({
      ...prev,
      ...nextHistoryMap
    }));
  
    return nextHistoryMap;
  }

  async function sendMessage() {
    if (pendingUploads.length > 0) {
      await uploadPreparedFiles(pendingUploads);
      return;
    }
  
    if (!socketRef.current || !me || !draft.trim()) return;
  
    if (selectedChatKind === 'direct' && !selectedUserId) return;
    if (selectedChatKind === 'group' && !selectedGroupId) return;
  
    const text = draft.trim();
    setDraft('');
    stopTyping();
    autoScrollRef.current = true;
  
    socketRef.current.emit('message:send', {
      fromUserId: me.id,
      toUserId: selectedChatKind === 'direct' ? selectedUserId : undefined,
      groupId: selectedChatKind === 'group' ? selectedGroupId : undefined,
      text,
      replyToMessageId: replyingTo?.id || null
    });
  
    if (selectedChatKind === 'direct') {
      forceMarkConversationAsRead(selectedUserId, activeMessagesRef.current);
    }
  
    setReplyingTo(null);
  
    requestAnimationFrame(() => {
      resizeComposerTextarea(true);
      focusComposer(false);
    });
  
    smoothScrollToBottom(true, false);
  }

  async function sendAttachment() {
    if (!me || !connectedServerUrl) return;
    if (selectedChatKind === 'direct' && !selectedUserId) return;
    if (selectedChatKind === 'group' && !selectedGroupId) return;
  
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
        showError(`Unable to read the selected file: ${fileName}`);
        return;
      }
  
      const mimeType = blob.type || guessMimeTypeFromName(fileName);
  
      prepared.push({
        file: blob,
        fileName,
        mimeType
      });
    }
  
    if (!prepared.length) {
      showError('No valid files selected.');
      return;
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
          showError(result?.error || 'Failed to delete message for you')
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
          showError(result?.error || 'Delete failed')
          return;
        }
  
        setDeleteMessageTargetId(null);
      }
    );
  }

  function startTyping() {
    if (!socketRef.current || !me) return;
  
    if (selectedChatKind === 'direct') {
      if (!selectedUserId) return;
  
      socketRef.current.emit('typing:set', {
        fromUserId: me.id,
        toUserId: selectedUserId,
        isTyping: true
      });
    } else {
      if (!selectedGroupId) return;
  
      socketRef.current.emit('typing:set', {
        fromUserId: me.id,
        groupId: selectedGroupId,
        isTyping: true
      });
    }
  
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => stopTyping(), 1200);
  }
  
  function stopTyping() {
    if (!socketRef.current || !me) return;
  
    if (selectedChatKind === 'direct') {
      if (!selectedUserId) return;
  
      socketRef.current.emit('typing:set', {
        fromUserId: me.id,
        toUserId: selectedUserId,
        isTyping: false
      });
    } else {
      if (!selectedGroupId) return;
  
      socketRef.current.emit('typing:set', {
        fromUserId: me.id,
        groupId: selectedGroupId,
        isTyping: false
      });
    }
  
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
  }

  async function startCall(mode: CallMode) {
    if (!socketRef.current || !me || !selectedUserId) return;
  
    try {
      await ensureLocalStream(mode);
    } catch (error) {
      const message = getCallDeviceErrorMessage(error, mode);
      setCallStatus(message);
      showToast(message, 'error', 4200);
      return;
    }
  
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
  
    socketRef.current.emit('call:invite', {
      fromUserId: me.id,
      toUserId: selectedUserId,
      mode
    });
  }

  async function acceptCall() {
    if (!incomingFromUserId || !socketRef.current || !me) return;
  
    const mode = incomingCallModeRef.current || 'video';
  
    try {
      await ensureLocalStream(mode);
    } catch (error) {
      const message = getCallDeviceErrorMessage(error, mode);
      setCallStatus(message);
      showToast(message, 'error', 4200);
      return;
    }
  
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

  function dismissToast() {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }

  function isGroupOwner(group: GroupChat | null, userId?: string | null) {
    return !!group && !!userId && group.ownerUserId === userId;
  }
  
  function isGroupAdmin(group: GroupChat | null, userId?: string | null) {
    return (
      !!group &&
      !!userId &&
      (group.ownerUserId === userId || group.adminUserIds.includes(userId))
    );
  }
  
  
  function showToast(message: string, tone: ToastTone = 'info', duration = 3600) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
  
    setToast({
      id: Date.now(),
      message,
      tone
    });
  
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  }

  function showError(message: string, duration = 4200) {
    showToast(message, 'error', duration);
  }
  
  function showSuccess(message: string, duration = 3200) {
    showToast(message, 'success', duration);
  }

  function canMarkConversationAsRead(peerUserId: string) {
    return (
      !!me &&
      selectedChatKind === 'direct' &&
      selectedUserIdRef.current === peerUserId &&
      isWindowActiveRef.current &&
      isMessagesNearBottom()
    );
  }

  async function loadAdminUsers() {
    const res = await apiFetch('/api/admin/users');
    const data = await res.json();
  
    if (!res.ok) {
      showError(data.error || 'Failed to load users');
      return;
    }
  
    setAdminUsers(data.users || []);
  }

  async function apiFetch(path: string, init: RequestInit = {}, tokenOverride?: string) {
    const headers = new Headers(init.headers || {});
    const token = tokenOverride || authToken || localStorage.getItem('lan_chat_auth_token') || '';
  
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  
    return fetch(`${connectedServerUrl || FIXED_SERVER_URL}${path}`, {
      ...init,
      headers
    });
  }
  
  function getUnreadIncomingMessages(peerUserId: string, sourceMessages: Message[]) {
    if (!me) return [];
  
    return sourceMessages.filter(
      (m) =>
        m.fromUserId === peerUserId &&
        m.toUserId === me.id &&
        isUnreadAffectingMessage(m, me.id) &&
        !m.readAt
    );
  }
  
  function markConversationAsReadLocally(peerUserId: string, sourceMessages: Message[]) {
    if (!me) return;
  
    const unreadIds = new Set(
      getUnreadIncomingMessages(peerUserId, sourceMessages).map((m) => m.id)
    );
  
    if (!unreadIds.size) return;
  
    const now = Date.now();
  
    setMessagesByConv((prev) => {
      const key = conversationKey(me.id, peerUserId);
      const current = prev[key] || [];
  
      return {
        ...prev,
        [key]: current.map((m) =>
          unreadIds.has(m.id)
            ? {
                ...m,
                deliveredAt: m.deliveredAt ?? now,
                readAt: now
              }
            : m
        )
      };
    });
  }
  
  function markUnreadMessagesAsRead(peerUserId: string, sourceMessages: Message[]) {
    if (!socketRef.current || !me) return;
    if (!canMarkConversationAsRead(peerUserId)) return;
  
    const unreadMessages = getUnreadIncomingMessages(peerUserId, sourceMessages);
    if (!unreadMessages.length) return;
  
    markConversationAsReadLocally(peerUserId, sourceMessages);
  
    unreadMessages.forEach((m) => {
      socketRef.current?.emit('message:read', {
        messageId: m.id,
        byUserId: me.id
      });
    });
  }

  function openGroupMembersModal() {
    setGroupMemberSearch('');
    setGroupMembersOpen(true);
  }

  function openGroupMemberTarget(userId: string) {
    setGroupMembersOpen(false);
  
    if (userId === me?.id) {
      setProfileOpen(true);
      return;
    }
  
    stopTyping();
    setActiveSidebarTab('chats');
    setSelectedChatKind('direct');
    setSelectedGroupId('');
    setHasExplicitContactSelection(true);
    setSelectedUserId(userId);
    autoScrollRef.current = true;
  
    requestAnimationFrame(() => {
      void loadHistory(userId, true);
      focusComposer(false);
    });
  }
  
  function updateMentionState(value: string, caret: number) {
    if (selectedChatKind !== 'group' || !selectedGroupId) {
      setMentionState(null);
      return;
    }
  
    const next = getActiveMention(value, caret);
  
    setMentionState((prev) => {
      const changed =
        prev?.start !== next?.start ||
        prev?.end !== next?.end ||
        prev?.query !== next?.query;
  
      if (changed) {
        setMentionActiveIndex(0);
      }
  
      return next;
    });
  }
  
  function insertMention(user: User) {
    const textarea = composerInputRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const active = getActiveMention(draft, caret);
  
    const mentionText = `@${user.userId} `;
    const replaceStart = active ? active.start : caret;
    const replaceEnd = active ? active.end : caret;
  
    const nextValue =
      draft.slice(0, replaceStart) +
      mentionText +
      draft.slice(replaceEnd);
  
    const nextCaret = replaceStart + mentionText.length;
  
    setDraft(nextValue);
    setMentionState(null);
    setMentionActiveIndex(0);
  
    requestAnimationFrame(() => {
      const el = composerInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      resizeComposerTextarea();
    });
  }
  
  function forceMarkConversationAsRead(peerUserId: string, sourceMessages: Message[]) {
    if (!socketRef.current || !me) return;
  
    const unreadMessages = getUnreadIncomingMessages(peerUserId, sourceMessages);
    if (!unreadMessages.length) return;
  
    markConversationAsReadLocally(peerUserId, sourceMessages);
  
    unreadMessages.forEach((m) => {
      socketRef.current?.emit('message:read', {
        messageId: m.id,
        byUserId: me.id
      });
    });
  }

  function getCallDeviceErrorMessage(error: unknown, mode: CallMode) {
    const err = error as DOMException | undefined;
  
    switch (err?.name) {
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return mode === 'audio'
          ? 'No microphone was found. Please connect a microphone and try again.'
          : 'Camera or microphone was not found. Please connect your devices and try again.';
  
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return mode === 'audio'
          ? 'Microphone access was denied. Please allow microphone permission and try again.'
          : 'Camera or microphone access was denied. Please allow permission and try again.';
  
      case 'NotReadableError':
      case 'TrackStartError':
        return mode === 'audio'
          ? 'Your microphone is being used by another app or is unavailable.'
          : 'Your camera or microphone is being used by another app or is unavailable.';
  
      case 'OverconstrainedError':
        return mode === 'audio'
          ? 'No matching microphone device is available.'
          : 'No matching camera or microphone device is available.';
  
      default:
        return mode === 'audio'
          ? 'Unable to start the voice call. Please check your microphone.'
          : 'Unable to start the video call. Please check your camera and microphone.';
    }
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
  
    const currentMe = meRef.current;
  
    const activeKey =
      currentMe
        ? selectedChatKindRef.current === 'group' && selectedGroupIdRef.current
          ? groupConversationKey(selectedGroupIdRef.current)
          : selectedUserIdRef.current
          ? conversationKey(currentMe.id, selectedUserIdRef.current)
          : ''
        : '';
  
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

  function openLightbox(items: Attachment[], index = 0) {
    if (!items.length) return;
    setLightbox({
      items,
      index: Math.max(0, Math.min(index, items.length - 1))
    });
  }
  
  function closeLightbox() {
    setLightbox(null);
  }

  function clearCurrentGroupConversationForMe() {
    if (!socketRef.current || !me || !deleteGroupChatTarget) return;
  
    socketRef.current.emit(
      'group:conversation:clear-for-me',
      {
        groupId: deleteGroupChatTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          showError(result?.error || 'Failed to delete group chat for you');
        }
      }
    );
  }
  
  function deleteCurrentGroupConversationForEveryone() {
    if (!socketRef.current || !me || !deleteGroupChatTarget) return;
  
    socketRef.current.emit(
      'group:conversation:delete',
      {
        groupId: deleteGroupChatTarget.id
      },
      (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          showError(result?.error || 'Failed to delete group chat for everyone');
        }
      }
    );
  }
  
  function showPrevLightbox() {
    setLightbox((prev) => {
      if (!prev || !prev.items.length) return prev;
      return {
        ...prev,
        index: (prev.index - 1 + prev.items.length) % prev.items.length
      };
    });
  }
  
  function showNextLightbox() {
    setLightbox((prev) => {
      if (!prev || !prev.items.length) return prev;
      return {
        ...prev,
        index: (prev.index + 1) % prev.items.length
      };
    });
  }
  
  function jumpToLightboxIndex(index: number) {
    setLightbox((prev) => {
      if (!prev || !prev.items.length) return prev;
      return {
        ...prev,
        index: Math.max(0, Math.min(index, prev.items.length - 1))
      };
    });
  }

  async function clearNotifications() {
    const res = await apiFetch('/api/notifications/clear', {
      method: 'POST'
    });
  
    const data = await res.json().catch(() => ({}));
  
    if (!res.ok) {
      showError(data.error || 'Failed to clear notifications');
      return;
    }
  
    setNotifications([]);
    setUnreadNotificationCount(0);
    showSuccess('Notifications cleared');
  }

  function userName(userId: string) {
    return users.find((u) => u.id === userId)?.name || userId;
  }

  function isGroupMember(group: GroupChat | null, userId?: string | null) {
    return !!group && !!userId && group.memberIds.includes(userId);
  }

  function isFileDrag(event: React.DragEvent | DragEvent) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  
  async function uploadPreparedFiles(files: PendingUpload[]) {
    if (!me || !connectedServerUrl) return false;
    if (selectedChatKind === 'direct' && !selectedUserId) return false;
    if (selectedChatKind === 'group' && !selectedGroupId) return false;
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
      if (selectedChatKind === 'group') {
        form.append('groupId', selectedGroupId);
      } else {
        form.append('toUserId', selectedUserId);
      }
      form.append('text', textForMessage);
  
      if (replyTarget?.id) {
        form.append('replyToMessageId', replyTarget.id);
      }
  
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: form
      });
  
      const data = await res.json().catch(() => ({}));
  
      if (!res.ok) {
        showError(data.error || 'Gallery upload failed');
        return false;
      }
    } else {
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        const form = new FormData();
  
        form.append('file', item.file, item.fileName);
        form.append('fromUserId', me.id);
        if (selectedChatKind === 'group') {
          form.append('groupId', selectedGroupId);
        } else {
          form.append('toUserId', selectedUserId);
        }
        form.append('text', i === 0 ? textForMessage : '');
  
        if (i === 0 && replyTarget?.id) {
          form.append('replyToMessageId', replyTarget.id);
        }
  
        const res = await apiFetch('/api/upload', {
          method: 'POST',
          body: form
        });
  
        const data = await res.json().catch(() => ({}));
  
        if (!res.ok) {
          showError(data.error || `Upload failed: ${item.fileName}`);
          return false;
        }
      }
    }

    if (selectedChatKind === 'direct') {
      forceMarkConversationAsRead(selectedUserId, activeMessagesRef.current);
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

  function groupTypingText(userIds: string[], users: User[]) {
    const names = userIds
      .map((id) => users.find((u) => u.id === id)?.name || id)
      .filter(Boolean);
  
    if (!names.length) return '';
  
    if (names.length === 1) {
      return `${names[0]} is typing...`;
    }
  
    if (names.length === 2) {
      return `${names[0]} and ${names[1]} are typing...`;
    }
  
    return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing...`;
  }

  function isMessagesNearBottom(threshold = 48) {
    const el = messagesRef.current;
    if (!el) return false;
  
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= threshold;
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
  
    if (selectedChatKindRef.current === 'group') {
      const groupId = selectedGroupIdRef.current;
      if (!groupId) return;
    
      const nearBottom = isMessagesNearBottom();
    
      if (suppressAutoReadUntilBottomRef.current) {
        if (!hasUserScrolledCurrentChatRef.current) return;
        if (!nearBottom) return;
    
        suppressAutoReadUntilBottomRef.current = false;
        autoScrollRef.current = true;
        markUnreadGroupMessagesAsRead(groupId, activeMessagesRef.current);
        return;
      }
    
      if (nearBottom) {
        autoScrollRef.current = true;
        markUnreadGroupMessagesAsRead(groupId, activeMessagesRef.current);
      }
    
      return;
    }
  
    if (selectedChatKindRef.current !== 'direct') return;
  
    const peerUserId = selectedUserIdRef.current;
    if (!peerUserId) return;
  
    const nearBottom = isMessagesNearBottom();
  
    if (suppressAutoReadUntilBottomRef.current) {
      if (!hasUserScrolledCurrentChatRef.current) return;
      if (!nearBottom) return;
  
      suppressAutoReadUntilBottomRef.current = false;
      autoScrollRef.current = true;
      markUnreadMessagesAsRead(peerUserId, activeMessagesRef.current);
      return;
    }
  
    if (nearBottom) {
      autoScrollRef.current = true;
      markUnreadMessagesAsRead(peerUserId, activeMessagesRef.current);
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
          showError(result?.error || 'Failed to delete chat for you');
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
          showError(result?.error || 'Failed to delete chat for everyone');
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

  function canUseAudioCallWith(user: User | null) {
    return !!me && !!user && me.canAudioCall !== false && user.canAudioCall !== false;
  }
  
  function canUseVideoCallWith(user: User | null) {
    return !!me && !!user && me.canVideoCall !== false && user.canVideoCall !== false;
  }

  function getLastDirectMessageAt(
    historyMap: Record<string, Message[]>,
    meId: string,
    peerUserId: string
  ) {
    const conv = historyMap[conversationKey(meId, peerUserId)] || [];
    return conv.length ? conv[conv.length - 1].createdAt : 0;
  }
  
  function pickPreferredDirectUserId(params: {
    meId: string;
    users: User[];
    onlineUserIds: string[];
    idleUserIds: string[];
    historyMap: Record<string, Message[]>;
  }) {
    const { meId, users, onlineUserIds, idleUserIds, historyMap } = params;
  
    const peers = users.filter((u) => u.id !== meId);
    if (!peers.length) return '';
  
    const onlineSet = new Set(onlineUserIds);
    const idleSet = new Set(idleUserIds);
  
    function presenceRank(userId: string) {
      if (onlineSet.has(userId)) return 0; // best
      if (idleSet.has(userId)) return 1;
      return 2; // offline
    }
  
    const sorted = [...peers].sort((a, b) => {
      const aPresence = presenceRank(a.id);
      const bPresence = presenceRank(b.id);
  
      if (aPresence !== bPresence) {
        return aPresence - bPresence;
      }
  
      const aLast = getLastDirectMessageAt(historyMap, meId, a.id);
      const bLast = getLastDirectMessageAt(historyMap, meId, b.id);
  
      if (aLast !== bLast) {
        return bLast - aLast;
      }
  
      return a.name.localeCompare(b.name);
    });
  
    return sorted[0]?.id || '';
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

  const selectedUser =
  selectedChatKind === 'direct'
    ? users.find((u) => u.id === selectedUserId) || null
    : null;

  const unreadCountByUser = useMemo(() => {
    if (!me) return {} as Record<string, number>;
  
    const result: Record<string, number> = {};
  
    for (const user of users) {
      if (user.id === me.id) continue;
  
      const conv = messagesByConv[conversationKey(me.id, user.id)] || [];
  
      result[user.id] = conv.filter(
        (m) =>
          m.fromUserId === user.id &&
          m.toUserId === me.id &&
          isUnreadAffectingMessage(m, me.id) &&
          !m.readAt
      ).length;
    }
  
    return result;
  }, [messagesByConv, users, me]);

  const unreadCountByGroup = useMemo(() => {
    if (!me) return {} as Record<string, number>;
  
    const result: Record<string, number> = {};
  
    for (const group of groups) {
      const conv = messagesByConv[groupConversationKey(group.id)] || [];
  
      result[group.id] = conv.filter(
        (m) =>
          m.groupId === group.id &&
          m.fromUserId !== me.id &&
          isUnreadAffectingMessage(m, me.id) &&
          !(m.groupReadByUserIds || []).includes(me.id)
      ).length;
    }
  
    return result;
  }, [groups, messagesByConv, me]);
  
  const totalUnreadCount = useMemo(() => {
    const directTotal = Object.values(unreadCountByUser).reduce((sum, count) => sum + count, 0);
    const groupTotal = Object.values(unreadCountByGroup).reduce((sum, count) => sum + count, 0);
    return directTotal + groupTotal;
  }, [unreadCountByUser, unreadCountByGroup]);

  const totalAppBadgeCount = useMemo(() => {
    return totalUnreadCount;
  }, [totalUnreadCount]);
  
  const activeMessages = useMemo(() => {
    if (!me) return [] as Message[];
  
    const key =
      selectedChatKind === 'group'
        ? selectedGroupId
          ? groupConversationKey(selectedGroupId)
          : ''
        : selectedUserId
        ? conversationKey(me.id, selectedUserId)
        : '';
  
    return key ? messagesByConv[key] || [] : [];
  }, [messagesByConv, me, selectedChatKind, selectedUserId, selectedGroupId]);  

  const firstUnreadMessageId = useMemo(() => {
    if (!me || selectedChatKind !== 'direct' || !selectedUserId) return null;
  
    const firstUnread = activeMessages.find(
      (m) =>
        !m.groupId &&
        m.fromUserId === selectedUserId &&
        m.toUserId === me.id &&
        isUnreadAffectingMessage(m, me.id) &&
        !m.readAt
    );
  
    return firstUnread?.id || null;
  }, [activeMessages, me, selectedChatKind, selectedUserId]);

  const firstUnreadGroupMessageId = useMemo(() => {
    if (!me || selectedChatKind !== 'group' || !selectedGroupId) return null;
  
    const firstUnread = activeMessages.find(
      (m) =>
        m.groupId === selectedGroupId &&
        m.fromUserId !== me.id &&
        isUnreadAffectingMessage(m, me.id) &&
        !(m.groupReadByUserIds || []).includes(me.id)
    );
  
    return firstUnread?.id || null;
  }, [activeMessages, me, selectedChatKind, selectedGroupId]);

  const deleteMessageTarget = useMemo(() => {
    if (!deleteMessageTargetId) return null;
    return activeMessages.find((m) => m.id === deleteMessageTargetId) || null;
  }, [deleteMessageTargetId, activeMessages]);

  useEffect(() => {
    activeMessagesRef.current = activeMessages;
  }, [activeMessages]);  

  useEffect(() => {
    if (selectedChatKind !== 'group' || !selectedGroupId) return;
  
    requestAnimationFrame(() => {
      if (firstUnreadGroupMessageId) {
        suppressAutoReadUntilBottomRef.current = true;
        hasUserScrolledCurrentChatRef.current = false;
  
        const targetEl = document.querySelector(
          `[data-message-id="${firstUnreadGroupMessageId}"]`
        ) as HTMLElement | null;
  
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'auto', block: 'center' });
          autoScrollRef.current = false;
          syncMessageViewportState();
  
          requestAnimationFrame(() => {
            const messagesEl = messagesRef.current;
            if (!messagesEl) return;
  
            const hasScrollableArea =
              messagesEl.scrollHeight > messagesEl.clientHeight + 1;
  
            if (!hasScrollableArea) {
              suppressAutoReadUntilBottomRef.current = false;
              hasUserScrolledCurrentChatRef.current = true;
              autoScrollRef.current = true;
  
              markUnreadGroupMessagesAsRead(selectedGroupId, activeMessagesRef.current);
              syncMessageViewportState();
            }
          });
  
          return;
        }
      }
  
      suppressAutoReadUntilBottomRef.current = false;
      smoothScrollToBottom(true, false);
    });
  }, [selectedGroupId, selectedChatKind, firstUnreadGroupMessageId]);
  
  useEffect(() => {
    if (selectedChatKind !== 'group' || !selectedGroupId) return;
  
    requestAnimationFrame(() => {
      if (autoScrollRef.current && !suppressAutoReadUntilBottomRef.current) {
        markUnreadGroupMessagesAsRead(selectedGroupId, activeMessagesRef.current);
      }
    });
  }, [selectedChatKind, selectedGroupId, activeMessages.length]);

  const contextTargetMessage = useMemo(() => {
    if (!contextMenu) return null;
    return activeMessages.find((m) => m.id === contextMenu.messageId) || null;
  }, [contextMenu, activeMessages]);

  const selectedGroup = useMemo(() => {
    return groups.find((g) => g.id === selectedGroupId) || null;
  }, [groups, selectedGroupId]);  

  const canSeeGeneralGroupTab =
  !!me && !!selectedGroup && isGroupAdmin(selectedGroup, me.id);

  const selectedGroupMembers = useMemo(() => {
    if (!selectedGroup) return [] as User[];
    return selectedGroup.memberIds
      .map((id) => users.find((u) => u.id === id))
      .filter(Boolean) as User[];
  }, [selectedGroup, users]);

  const filteredGroupMembers = useMemo(() => {
    const q = groupMemberSearch.trim().toLowerCase();
    if (!q) return selectedGroupMembers;
  
    return selectedGroupMembers.filter((user) => {
      return (
        user.name.toLowerCase().includes(q) ||
        user.userId.toLowerCase().includes(q)
      );
    });
  }, [selectedGroupMembers, groupMemberSearch]);

  const mentionCandidates = useMemo(() => {
    if (selectedChatKind !== 'group' || !selectedGroup || !mentionState) {
      return [] as User[];
    }
  
    const q = mentionState.query.trim();
  
    return selectedGroupMembers
      .filter((user) => {
        if (!q) return true;
  
        return (
          user.name.toLowerCase().includes(q) ||
          user.userId.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aRank =
          selectedGroup.ownerUserId === a.id
            ? 0
            : selectedGroup.adminUserIds.includes(a.id)
            ? 1
            : 2;
  
        const bRank =
          selectedGroup.ownerUserId === b.id
            ? 0
            : selectedGroup.adminUserIds.includes(b.id)
            ? 1
            : 2;
  
        if (aRank !== bRank) return aRank - bRank;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [selectedChatKind, selectedGroup, selectedGroupMembers, mentionState]);
  
  const selectedGroupInviteCandidates = useMemo(() => {
    if (!selectedGroup || !me) return [] as User[];
  
    return users.filter((user) => {
      if (user.id === me.id) return false;
      if (selectedGroup.memberIds.includes(user.id)) return false;
      if (selectedGroup.invitedUserIds.includes(user.id)) return false;
      if (selectedGroup.joinRequestUserIds.includes(user.id)) return false;
      return true;
    });
  }, [selectedGroup, users, me]);
  
  const pendingGroupInvites = useMemo(() => {
    return [...groupInvites].sort((a, b) => b.createdAt - a.createdAt);
  }, [groupInvites]);
  
  const pendingGroupJoinApprovals = useMemo(() => {
    if (!selectedGroup) return [] as User[];
    return selectedGroup.joinRequestUserIds
      .map((id) => users.find((u) => u.id === id))
      .filter(Boolean) as User[];
  }, [selectedGroup, users]);
  
  const activeGroupTypingUsers = useMemo(() => {
    if (selectedChatKind !== 'group' || !selectedGroupId) return [] as string[];
    return groupTypingByChat[groupConversationKey(selectedGroupId)] || [];
  }, [groupTypingByChat, selectedChatKind, selectedGroupId]);
  
  const directHeaderTypingText = useMemo(() => {
    if (selectedChatKind !== 'direct' || !selectedUser) return '';
    return typingFrom[selectedUser.id] ? 'typing...' : '';
  }, [selectedChatKind, selectedUser, typingFrom]);
  
  const groupHeaderTypingText = useMemo(() => {
    if (selectedChatKind !== 'group' || !selectedGroupId) return '';
    return groupTypingText(activeGroupTypingUsers, users);
  }, [selectedChatKind, selectedGroupId, activeGroupTypingUsers, users]);

  useEffect(() => {
    if (!connectedServerUrl || !me) return;
  
    if (selectedChatKind === 'group') {
      if (!selectedGroupId) return;
      void loadGroupHistory(selectedGroupId);
      return;
    }
  
    if (!selectedUserId) return;
    void loadHistory(selectedUserId);
  }, [selectedUserId, selectedGroupId, selectedChatKind, me, connectedServerUrl]);

  useEffect(() => {
    if (!groupManageOpen || !selectedGroup || !me) return;
  
    setGroupManageTab(
      isGroupAdmin(selectedGroup, me.id) ? 'general' : 'members'
    );
    setGroupEditTitle(selectedGroup.title || '');
  }, [groupManageOpen, selectedGroup, me]);

  useEffect(() => {
    if (!replyingTo) return;
    focusComposer();
  }, [replyingTo]);

  useEffect(() => {
    if (selectedChatKind === 'group' && selectedGroupId) {
      focusComposer();
      return;
    }
  
    if (selectedChatKind === 'direct' && selectedUserId) {
      focusComposer();
    }
  }, [selectedUserId, selectedGroupId, selectedChatKind]);

  const chatListItems = useMemo(() => {
    if (!me) return [] as ContactListItem[];
  
    const q = search.trim().toLowerCase();
  
    const groupItems: ContactListItem[] = groups
      .filter((group) => !q || group.title.toLowerCase().includes(q))
      .map((group) => {
        const conv = messagesByConv[groupConversationKey(group.id)] || [];
        const last = conv[conv.length - 1];
        const typingUsers = groupTypingByChat[groupConversationKey(group.id)] || [];
  
        return {
          kind: 'group',
          id: group.id,
          title: group.title,
          group,
          last,
          unreadCount: unreadCountByGroup[group.id] || 0,
          typingText: groupTypingText(typingUsers, users),
          sortAt: last?.createdAt || group.updatedAt || group.createdAt || 0
        };
      });
  
    const directItems: ContactListItem[] = users
      .filter((user) => user.id !== me.id)
      .filter(
        (user) =>
          !q ||
          user.name.toLowerCase().includes(q) ||
          user.userId.toLowerCase().includes(q)
      )
      .map((user) => {
        const conv = messagesByConv[conversationKey(me.id, user.id)] || [];
        const last = conv[conv.length - 1];
        const presence = getPresence(user.id);
  
        return {
          kind: 'direct',
          id: user.id,
          title: user.name,
          user,
          last,
          unreadCount: unreadCountByUser[user.id] || 0,
          typingText: typingFrom[user.id] ? 'typing...' : '',
          presence,
          selectedTogether:
            (presence === 'online' || presence === 'idle') &&
            isSelectedTogether(user.id),
          sortAt: last?.createdAt || user.createdAt || 0
        };
      });
  
    return [...groupItems, ...directItems].sort((a, b) => {
      if (b.sortAt !== a.sortAt) return b.sortAt - a.sortAt;
      return a.title.localeCompare(b.title);
    });
  }, [
    me,
    search,
    groups,
    users,
    messagesByConv,
    groupTypingByChat,
    unreadCountByGroup,
    unreadCountByUser,
    typingFrom,
    onlineUserIds,
    idleUserIds,
    activeChatTargets
  ]);

  useEffect(() => {
    if (selectedChatKind !== 'direct' || !selectedUserId) return;
  
    requestAnimationFrame(() => {
      if (firstUnreadMessageId) {
        suppressAutoReadUntilBottomRef.current = true;
        hasUserScrolledCurrentChatRef.current = false;
  
        const targetEl = document.querySelector(
          `[data-message-id="${firstUnreadMessageId}"]`
        ) as HTMLElement | null;
  
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'auto', block: 'center' });
          autoScrollRef.current = false;
          syncMessageViewportState();
  
          requestAnimationFrame(() => {
            const messagesEl = messagesRef.current;
            if (!messagesEl) return;
  
            const hasScrollableArea =
              messagesEl.scrollHeight > messagesEl.clientHeight + 1;
  
            if (!hasScrollableArea) {
              suppressAutoReadUntilBottomRef.current = false;
              hasUserScrolledCurrentChatRef.current = true;
              autoScrollRef.current = true;
  
              markUnreadMessagesAsRead(selectedUserId, activeMessagesRef.current);
              syncMessageViewportState();
            }
          });
  
          return;
        }
      }
  
      suppressAutoReadUntilBottomRef.current = false;
      smoothScrollToBottom(true, false);
    });
  }, [selectedUserId, selectedChatKind, firstUnreadMessageId]);
  
  useEffect(() => {
    if (selectedChatKind === 'group') {
      if (autoScrollRef.current || !firstUnreadGroupMessageId) {
        smoothScrollToBottom(false, false);
      }
      return;
    }
  
    if (!selectedUserId) return;
  
    if (autoScrollRef.current || !firstUnreadMessageId) {
      smoothScrollToBottom(false, false);
    }
  }, [
    activeMessages.length,
    selectedUserId,
    selectedGroupId,
    selectedChatKind,
    firstUnreadMessageId,
    firstUnreadGroupMessageId
  ]);

  useEffect(() => {
    const baseTitle = 'LAN Chat';
  
    document.title =
      totalAppBadgeCount > 0 ? `(${totalAppBadgeCount}) ${baseTitle}` : baseTitle;
  
    void desktopApi.setBadgeCount?.(totalAppBadgeCount);
  }, [totalAppBadgeCount]);

  useEffect(() => {
    const onResize = () => updateMessageScrollbar();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toastNode = toast ? (
    <div className={`app-toast ${toast.tone}`} role="status" aria-live="polite">
      <div className="app-toast-content">
        <span className="app-toast-icon">
          {toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '⚠' : 'i'}
        </span>
        <span className="app-toast-message">{toast.message}</span>
      </div>
  
      <button
        type="button"
        className="app-toast-close"
        onClick={dismissToast}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  ) : null;

  if (!me) {
    return (
      <>
        <div className="login-shell">
          <div className="login-card auth-card">
            <div className="pill">LAN Chat</div>
            <h1>{authMode === 'login' ? 'Login' : 'Register'}</h1>
            <p>
              {authMode === 'login'
                ? 'Sign in with your user ID and password.'
                : 'Create a new account. New user accounts require admin approval.'}
            </p>
  
            <div className="auth-tabs">
              <button
                className={`auth-tab ${authMode === 'login' ? 'active' : ''}`}
                onClick={() => setAuthMode('login')}
              >
                Login
              </button>
              <button
                className={`auth-tab ${authMode === 'register' ? 'active' : ''}`}
                onClick={() => setAuthMode('register')}
              >
                Register
              </button>
            </div>
  
            <label className="field">
              <span>User ID</span>
              <input
                value={loginUserId}
                onChange={(e) => setLoginUserId(e.target.value)}
                placeholder="john.smith"
              />
            </label>
  
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
              />
            </label>
  
            {authMode === 'register' ? (
              <label className="field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                />
              </label>
            ) : null}

            <button
              className="primary"
              onClick={authMode === 'login' ? handleLogin : handleRegister}
            >
              {authMode === 'login' ? 'Login' : 'Register'}
            </button>

            <div className="foot-note">
              Server: {FIXED_SERVER_URL}
            </div>  
  
            <div className="foot-note">
              App {appInfo?.appVersion || ''} · {appInfo?.platform || ''}
            </div>
          </div>
        </div>
  
        {toastNode}
      </>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="profile-card">
            <UserAvatar user={me} serverUrl={connectedServerUrl} />
            <div className="profile-meta">
              <div className="name">{me.userId}</div>
              <div className="sub">{me.name}</div>
            </div>
          </div>

          <div className="sidebar-top-actions">
            <div className="top-actions-menu-wrap" ref={sidebarMenuRef}>
              <button
                className={`icon-btn ${sidebarMenuOpen ? 'active' : ''}`}
                onClick={() => setSidebarMenuOpen((prev) => !prev)}
                title="Options"
                aria-label="Options"
              >
                ⋮
              </button>

              {sidebarMenuOpen ? (
                <div
                  className="top-actions-popup"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="top-actions-popup-item"
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      setProfileOpen(true);
                    }}
                  >
                    <span className="top-actions-popup-icon">⚙</span>
                    <span>Profile</span>
                  </button>

                  <button
                    className="top-actions-popup-item"
                    onClick={() => {
                      setSidebarMenuOpen(false);
                      setGroupCreateOpen(true);
                    }}
                  >
                    <span className="top-actions-popup-icon">＋</span>
                    <span>Create group</span>
                  </button>

                  {me.role === 'admin' ? (
                    <button
                      className="top-actions-popup-item"
                      onClick={() => {
                        setSidebarMenuOpen(false);
                        loadAdminUsers();
                        setAdminOpen(true);
                      }}
                    >
                      <span className="top-actions-popup-icon">🛡</span>
                      <span>Admin users</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <button
              className="icon-btn"
              onClick={() => {
                void handleLogout();
              }}
              title="Logout"
              aria-label="Logout"
            >
              ⎋
            </button>
          </div>
        </div>

        <div className="search-wrap">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Searching..." />
          <span>⌕</span>
        </div>

        <div className="tabs">
          <button
            className={`tab ${activeSidebarTab === 'chats' ? 'active' : ''}`}
            onClick={() => setActiveSidebarTab('chats')}
            title="Chats"
            aria-label="Chats"
          >
            <span className="tab-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M7 18L3.5 20.5L4.5 16.5C3.6 15.3 3 13.8 3 12C3 7.6 7 4 12 4C17 4 21 7.6 21 12C21 16.4 17 20 12 20C10.2 20 8.5 19.3 7 18Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>

          <button
            className={`tab ${activeSidebarTab === 'calls' ? 'active' : ''}`}
            onClick={() => setActiveSidebarTab('calls')}
            title="Calls"
            aria-label="Calls"
          >
            <span className="tab-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6.6 4.8L9.3 4C9.7 3.9 10.2 4.1 10.4 4.5L11.7 7.6C11.9 8 11.8 8.5 11.4 8.8L9.9 10C10.8 11.9 12.1 13.2 14 14.1L15.2 12.6C15.5 12.2 16 12.1 16.4 12.3L19.5 13.6C19.9 13.8 20.1 14.3 20 14.7L19.2 17.4C19.1 17.8 18.7 18 18.3 18C10.9 18 6 13.1 6 5.7C6 5.3 6.2 4.9 6.6 4.8Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>

          <button
            className={`tab ${activeSidebarTab === 'invitations' ? 'active' : ''}`}
            onClick={() => setActiveSidebarTab('invitations')}
            title="Invitations"
            aria-label="Invitations"
          >
            <span className="tab-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 7.5C4 6.7 4.7 6 5.5 6H18.5C19.3 6 20 6.7 20 7.5V16.5C20 17.3 19.3 18 18.5 18H5.5C4.7 18 4 17.3 4 16.5V7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M5 7L12 12L19 7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>

              {invitationCount > 0 ? (
                <span className="tab-badge">
                  {invitationCount > 99 ? '99+' : invitationCount}
                </span>
              ) : null}
            </span>
          </button>

          <button
            className={`tab ${activeSidebarTab === 'notifications' ? 'active' : ''}`}
            onClick={() => setActiveSidebarTab('notifications')}
            title="Notifications"
            aria-label="Notifications"
          >
            <span className="tab-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 20C13.1 20 14 19.1 14 18H10C10 19.1 10.9 20 12 20Z"
                  fill="currentColor"
                />
                <path
                  d="M6 17H18L16.8 15.4V11C16.8 8.2 14.9 6 12.4 5.4V4.8C12.4 4.4 12.1 4 11.7 4C11.3 4 11 4.4 11 4.8V5.4C8.5 6 6.6 8.2 6.6 11V15.4L6 17Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>

              {unreadNotificationCount > 0 ? (
                <span className="tab-badge">
                  {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                </span>
              ) : null}
            </span>
          </button>
        </div>

        <div className="contact-list">
          {activeSidebarTab === 'chats' ? (
            chatListItems.length ? (
              <div className="contact-group">
                {chatListItems.map((item) => {
                  if (item.kind === 'group') {
                    const { group, last, unreadCount, typingText } = item;

                    return (
                      <button
                        key={group.id}
                        className={`contact-card ${
                          selectedChatKind === 'group' && selectedGroupId === group.id ? 'selected' : ''
                        }`}
                        onClick={() => handleSelectGroup(group.id)}
                      >
                        <div className="contact-avatar-wrap">
                          <UserAvatar
                            user={{
                              id: group.id,
                              userId: group.title,
                              name: group.title,
                              avatarUrl: group.avatarUrl || null
                            }}
                            serverUrl={connectedServerUrl}
                          />
                        </div>

                        <div className="contact-text">
                          <div className="contact-head">
                            <span className="contact-name">{group.title}</span>

                            <div className="contact-head-right">
                              <span className="contact-time">{timeLabel(last?.createdAt)}</span>

                              {unreadCount > 0 ? (
                                <span className="contact-badge below-time">
                                  {unreadCount > 99 ? '99+' : unreadCount}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="contact-preview">
                            {typingText
                              ? typingText
                              : last
                              ? previewText(last, me.id, users)
                              : `${group.memberIds.length} members`}
                          </div>
                        </div>
                      </button>
                    );
                  }

                  const { user, last, unreadCount, typingText, presence, selectedTogether } = item;

                  return (
                    <button
                      key={user.id}
                      className={`contact-card ${presence === 'offline' ? 'offline' : ''} ${
                        selectedChatKind === 'direct' && selectedUserId === user.id ? 'selected' : ''
                      }`}
                      onClick={() => handleSelectContact(user.id)}
                    >
                      <div className="contact-avatar-wrap">
                        <UserAvatar user={user} serverUrl={connectedServerUrl} />
                        {presence !== 'offline' ? (
                          <span
                            className={`online-dot ${presence === 'idle' ? 'idle' : ''} ${
                              selectedTogether ? 'selected-together' : ''
                            }`}
                          />
                        ) : null}
                      </div>

                      <div className="contact-text">
                        <div className="contact-head">
                          <span className="contact-name">{user.name}</span>

                          <div className="contact-head-right">
                            <span className="contact-time">{timeLabel(last?.createdAt)}</span>

                            {unreadCount > 0 ? (
                              <span className="contact-badge below-time">
                                {unreadCount > 99 ? '99+' : unreadCount}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="contact-preview">
                          {typingText ? typingText : previewText(last, me.id, users)}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="admin-empty">No chats found.</div>
            )
          ) : activeSidebarTab === 'calls' ? (
            <div className="contact-group">
              <div className="contact-group-title">All Call History</div>

              {allCallHistory.length ? (
                allCallHistory.map(({ message, peerUserId, peer }) => {
                  const displayName = peer?.name || userName(peerUserId);
                  const isSelected = selectedChatKind === 'direct' && selectedUserId === peerUserId;

                  return (
                    <button
                      key={message.id}
                      className={`contact-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveSidebarTab('chats');
                        handleSelectContact(peerUserId);
                      }}
                    >
                      <div className="contact-avatar-wrap">
                        <UserAvatar
                          user={
                            peer || {
                              id: peerUserId,
                              userId: peerUserId,
                              name: displayName
                            }
                          }
                          serverUrl={connectedServerUrl}
                        />
                      </div>

                      <div className="contact-text">
                        <div className="contact-head">
                          <span className="contact-name">{displayName}</span>
                          <div className="contact-head-right">
                            <span className="contact-time">
                              {timeLabel(message.createdAt)}
                            </span>
                          </div>
                        </div>

                        <div className="contact-preview">
                          {callHistoryLabel(message, me.id, users)}
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="admin-empty">No call history yet.</div>
              )}
            </div>
          ) : activeSidebarTab === 'invitations' ? (
            <div className="contact-group">
              <div className="contact-group-title">Group invitations</div>
          
              {pendingGroupInvites.length ? (
  pendingGroupInvites.map((invite) => {
    const isRequested = invite.status === 'requested';

    return (
      <div
        key={`${invite.groupId}_${invite.status}`}
        className="admin-user-row invitation-row"
      >
        <div className="admin-user-main invitation-main">
          <UserAvatar
            user={{
              id: invite.groupId,
              userId: invite.title,
              name: invite.title,
              avatarUrl: invite.avatarUrl || null
            }}
            serverUrl={connectedServerUrl}
            size="small"
          />
          <div className="invitation-text">
            <div className="contact-name">{invite.title}</div>
            <div className="contact-preview invitation-preview">
              {isRequested
                ? 'Waiting for owner approval'
                : 'You have been invited to this group'}
            </div>
          </div>
        </div>

        <div className="invitation-actions">
          {isRequested ? (
            <button
              className="icon-btn wide"
              onClick={() => {
                void declineGroupInvite(invite.groupId);
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                className="icon-btn wide"
                onClick={() => {
                  void declineGroupInvite(invite.groupId);
                }}
              >
                Decline
              </button>

              <button
                className="primary invitation-accept-btn"
                onClick={() => {
                  void acceptGroupInvite(invite.groupId);
                }}
              >
                Accept
              </button>
            </>
          )}
        </div>
      </div>
    );
  })
              ) : (
                <div className="admin-empty">No invitations yet.</div>
              )}
            </div>
          ) : (
            <div className="contact-group">
              <div
                className="contact-group-title"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12
                }}
              >
                <span>Notifications</span>
          
                <button
                  type="button"
                  className="icon-btn small"
                  onClick={() => {
                    void clearNotifications();
                  }}
                  disabled={!notifications.length}
                  title="Clear notifications"
                >
                  Clear
                </button>
              </div>
          
              {notifications.length ? (
                notifications.map((item) => {
                  const matchedUser = item.userId
                    ? users.find((u) => u.id === item.userId)
                    : null;

                  const matchedGroup = item.groupId
                    ? groups.find((g) => g.id === item.groupId)
                    : null;

                  const avatarUser =
                    item.kind === 'group'
                      ? {
                          id: item.groupId || item.id,
                          userId: matchedGroup?.title || item.title,
                          name: matchedGroup?.title || item.title,
                          avatarUrl: matchedGroup?.avatarUrl || item.avatarUrl || null
                        }
                      : {
                          id: item.userId || item.id,
                          userId: matchedUser?.userId || item.userName,
                          name: matchedUser?.name || item.userName,
                          avatarUrl: matchedUser?.avatarUrl || item.avatarUrl || null
                        };

                  const heading = item.kind === 'group' ? item.title : item.userName;

                  return (
                    <div key={item.id} className="contact-card">
                      <div className="contact-avatar-wrap">
                        <UserAvatar user={avatarUser} serverUrl={connectedServerUrl} />
                      </div>

                      <div className="contact-text">
                        <div className="contact-head">
                          <span className="contact-name">{heading}</span>
                          <div className="contact-head-right">
                            <span className="contact-time">{timeLabel(item.createdAt)}</span>
                          </div>
                        </div>

                        <div className="contact-preview">{notificationText(item)}</div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="admin-empty">No notifications yet.</div>
              )}
            </div>
          )}
        </div>
      </aside>

      <main
        className={`chat-panel ${isDragOver ? 'drag-active' : ''}`}
        onDragEnter={handleChatDragEnter}
        onDragOver={handleChatDragOver}
        onDragLeave={handleChatDragLeave}
        onDrop={handleChatDrop}
      >
        {(selectedChatKind === 'group' ? selectedGroup : selectedUser) ? (
          <>
            <header className="chat-header">
              {selectedChatKind === 'group' && selectedGroup ? (
                <>
                  <div className="chat-person">
                    <button
                      type="button"
                      className="group-icon-trigger"
                      onClick={openGroupMembersModal}
                      title="Show group members"
                      aria-label="Show group members"
                    >
                      <div className="contact-avatar-wrap">
                        <UserAvatar
                          user={{
                            id: selectedGroup.id,
                            userId: selectedGroup.title,
                            name: selectedGroup.title,
                            avatarUrl: selectedGroup.avatarUrl || null
                          }}
                          serverUrl={connectedServerUrl}
                        />
                      </div>
                    </button>

                    <div>
                      <div className="name">{selectedGroup.title}</div>
                      <div className="sub">
                        <span>{selectedGroup.memberIds.length} members</span>
                        {groupHeaderTypingText ? (
                          <>
                            <span className="chat-sub-separator">·</span>
                            <span className="chat-header-typing">{groupHeaderTypingText}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
              
                  {isGroupMember(selectedGroup, me.id) ? (
                    <div className="header-actions">
                      <button
                        className="icon-btn"
                        onClick={() => setDeleteGroupChatTargetId(selectedGroup.id)}
                        title="Delete chat"
                      >
                        🗑
                      </button>
                    
                      <button
                        className="icon-btn"
                        onClick={() => setGroupManageOpen(true)}
                        title="Manage group"
                      >
                        ⚙
                      </button>
                    </div>
                  ) : null}
                </>
              ) : selectedUser ? (
                <>
                  <div className="chat-person">
                    <div className="contact-avatar-wrap">
                      <UserAvatar user={selectedUser} serverUrl={connectedServerUrl} />
                      {getPresence(selectedUser.id) !== 'offline' ? (
                        <span
                          className={`online-dot ${getPresence(selectedUser.id) === 'idle' ? 'idle' : ''} ${
                            (getPresence(selectedUser.id) === 'online' || getPresence(selectedUser.id) === 'idle') &&
                            isSelectedTogether(selectedUser.id)
                              ? 'selected-together'
                              : ''
                          }`}
                        />
                      ) : null}
                    </div>
                    <div>
                      <div className="name">{selectedUser.name}</div>
                      <div className="sub">
                        <span>
                          {getPresence(selectedUser.id) === 'online'
                            ? 'Online'
                            : getPresence(selectedUser.id) === 'idle'
                            ? 'Idle'
                            : 'Offline'}
                        </span>

                        {directHeaderTypingText ? (
                          <>
                            <span className="chat-sub-separator">·</span>
                            <span className="chat-header-typing">{directHeaderTypingText}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="header-actions">
                    <button
                      className="icon-btn"
                      onClick={() => {
                        if (!canUseAudioCallWith(selectedUser)) {
                          showToast('Audio call is not allowed for this user.', 'error', 3200);
                          return;
                        }
                        void startCall('audio');
                      }}
                      title="Audio call"
                    >
                      📞
                    </button>

                    <button
                      className="icon-btn"
                      onClick={() => {
                        if (!canUseVideoCallWith(selectedUser)) {
                          showToast('Video call is not allowed for this user.', 'error', 3200);
                          return;
                        }
                        void startCall('video');
                      }}
                      title="Video call"
                    >
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
                </>
              ) : null}
            </header>

            <div className="messages-wrap">
              <section
                className="messages"
                ref={messagesRef}
                onScroll={handleMessagesScroll}
                onWheel={registerManualMessageScroll}
                onTouchMove={registerManualMessageScroll}
                onMouseDown={registerManualMessageScroll}
              >
                {activeMessages.map((m, idx) => {
                  const mine = m.fromUserId === me.id;
                  const prev = activeMessages[idx - 1];
                  const next = activeMessages[idx + 1];
                  const showUnreadDivider =
                    !mine &&
                    ((selectedChatKind === 'direct' && firstUnreadMessageId === m.id) ||
                      (selectedChatKind === 'group' && firstUnreadGroupMessageId === m.id));

                  const showDivider =
                    !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();

                  const nextIsSameSenderGroup = isRenderableMessage(next) && next!.fromUserId === m.fromUserId;
                  const showAvatarForThisMessage = !nextIsSameSenderGroup;

                  const attachments = getMessageAttachments(m);
                  const isGallery = isGalleryMessage(m);
                  const useTelegramInlineMeta = !!m.text && attachments.length === 0;

                  return (
                    <div key={m.id} data-message-id={m.id}>
                      {showUnreadDivider ? (
                        <div className="system-chip-row">
                          <div className="system-chip unread-chip">
                            <span className="system-chip-text">Unread messages</span>
                          </div>
                        </div>
                      ) : null}

                      {showDivider ? (
                        <div className="system-chip-row date-chip-row">
                          <div className="system-chip date-chip">
                            <span className="system-chip-text">{dateDivider(m.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}

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
                                <UserAvatar
                                  user={getRenderableUser(m.fromUserId)}
                                  serverUrl={connectedServerUrl}
                                  size="small"
                                />
                              </div>
                            ) : (
                              <div className="message-avatar-spacer" />
                            )
                          ) : null}

                          <div className="message-stack">
                            <div className={`bubble ${mine ? 'mine' : ''} ${useTelegramInlineMeta ? 'telegram-inline-meta' : ''}`}>
                              {selectedChatKind === 'group' && !mine ? (
                                <div className="reply-preview-author" style={{ marginBottom: 6 }}>
                                  {userName(m.fromUserId)}
                                </div>
                              ) : null}
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
                                <GalleryPreview
                                  attachments={attachments}
                                  serverUrl={connectedServerUrl}
                                  onOpenImage={(index) => openLightbox(attachments, index)}
                                />
                              ) : null}

                              {m.text ? (
                                useTelegramInlineMeta ? (
                                  <div className="message-text with-inline-meta">
                                    <span className="message-text-content">{m.text}</span>

                                    <span className="message-inline-meta-spacer" aria-hidden="true">
                                      <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                      {mine && isMessageStatusVisible(m) ? <MessageStatus message={m} /> : null}
                                    </span>

                                    <span className={`message-inline-meta ${mine ? 'mine' : ''}`}>
                                      <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                      {mine && isMessageStatusVisible(m) ? <MessageStatus message={m} /> : null}
                                    </span>
                                  </div>
                                ) : (
                                  <div className={`message-text ${isGallery ? 'gallery-caption' : ''}`}>
                                    {m.text}
                                  </div>
                                )
                              ) : null}

                              {!isGallery && attachments.length === 1 ? (
                                <AttachmentPreview
                                  attachment={attachments[0]}
                                  serverUrl={connectedServerUrl}
                                  onOpenImage={() => {
                                    if (attachments[0].isImage) {
                                      openLightbox([attachments[0]], 0);
                                    }
                                  }}
                                />
                              ) : null}

                              {!useTelegramInlineMeta ? (
                                <div className={`bubble-meta ${mine ? 'mine' : ''}`}>
                                  <span className="bubble-time">{timeLabel(m.createdAt)}</span>
                                  {mine && isMessageStatusVisible(m) ? <MessageStatus message={m} /> : null}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {mine ? (
                            showAvatarForThisMessage ? (
                              <div className="message-avatar">
                                <UserAvatar user={me} serverUrl={connectedServerUrl} size="small" />
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
                    hasUserScrolledCurrentChatRef.current = true;
                    suppressAutoReadUntilBottomRef.current = false;
                    autoScrollRef.current = true;
                    smoothScrollToBottom(true, true);
                  
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        if (selectedChatKindRef.current === 'group' && selectedGroupIdRef.current) {
                          markUnreadGroupMessagesAsRead(
                            selectedGroupIdRef.current,
                            activeMessagesRef.current
                          );
                          return;
                        }
                  
                        if (selectedUserIdRef.current) {
                          markUnreadMessagesAsRead(selectedUserIdRef.current, activeMessagesRef.current);
                        }
                      });
                    });
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
                {selectedChatKind === 'group' && mentionState ? (
                  <div className="mention-popup">
                    {mentionCandidates.length ? (
                      mentionCandidates.map((user, index) => (
                        <button
                          key={user.id}
                          type="button"
                          className={`mention-popup-item ${index === mentionActiveIndex ? 'active' : ''}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => insertMention(user)}
                        >
                          <UserAvatar
                            user={user}
                            serverUrl={connectedServerUrl}
                            size="small"
                          />

                          <div className="mention-popup-meta">
                            <div className="mention-popup-name">{user.name}</div>
                            <div className="mention-popup-sub">
                              @{user.userId} · {getGroupRoleLabel(selectedGroup, user.id)}
                            </div>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="mention-popup-empty">No members found</div>
                    )}
                  </div>
                ) : null}
                <textarea
                  ref={composerInputRef}
                  className="composer-input"
                  value={draft}
                  rows={1}
                  onChange={(e) => {
                    const value = e.target.value;
                    const caret = e.target.selectionStart ?? value.length;

                    setDraft(value);
                    startTyping();
                    resizeComposerTextarea();
                    updateMentionState(value, caret);
                  }}
                  onClick={(e) => {
                    updateMentionState(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length
                    );
                  }}
                  onKeyUp={(e) => {
                    updateMentionState(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length
                    );
                  }}
                  onPaste={handleComposerPaste}
                  onBlur={() => {
                    stopTyping();
                    window.setTimeout(() => {
                      setMentionState(null);
                    }, 120);
                  }}
                  onKeyDown={(e) => {
                    if (selectedChatKind === 'group' && mentionState) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (mentionCandidates.length) {
                          setMentionActiveIndex((prev) =>
                            prev + 1 >= mentionCandidates.length ? 0 : prev + 1
                          );
                        }
                        return;
                      }

                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (mentionCandidates.length) {
                          setMentionActiveIndex((prev) =>
                            prev - 1 < 0 ? mentionCandidates.length - 1 : prev - 1
                          );
                        }
                        return;
                      }

                      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && mentionCandidates.length) {
                        e.preventDefault();
                        insertMention(mentionCandidates[mentionActiveIndex] || mentionCandidates[0]);
                        return;
                      }

                      if (e.key === 'Escape') {
                        setMentionState(null);
                        return;
                      }
                    }

                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder={pendingUploads.length ? 'Add a caption' : 'Type a message'}
                />
              </div>

              <div className="composer-actions">
                <button className="icon-btn small" onClick={sendAttachment} title="Attach file">
                  📎
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

      {incomingFromUserId ? (
        <div className="incoming-box tg-incoming-call">
          <div className="tg-incoming-call-top">
            <div className="tg-incoming-avatar-wrap">
              <UserAvatar
                user={getRenderableUser(incomingFromUserId)}
                serverUrl={connectedServerUrl}
                size="large"
              />
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
            <button className="success" onClick={() => { void acceptCall(); }}>
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

      {adminOpen ? (
        <div className="call-overlay">
          <div className="call-modal admin-modal">
            <div className="call-top">
              <div>
                <div className="call-name">Admin · User Access</div>
                <div className="call-sub">Approve users and control login / call permissions</div>
              </div>
            </div>

            <div className="admin-toolbar">
              <input
                className="admin-search-input"
                value={adminSearch}
                onChange={(e) => setAdminSearch(e.target.value)}
                placeholder="Search by display name or user ID"
              />
            </div>

            <div className="admin-user-list">
              {filteredAdminUsers.map((user) => (
                <div key={user.id} className="admin-user-row">
                  <div className="admin-user-main">
                    <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                    <div>
                      <div className="contact-name">{user.name}</div>
                      <div className="contact-preview">
                        @{user.userId} {user.role === 'admin' ? '· Admin' : ''}
                      </div>
                    </div>
                  </div>

                  <div className="admin-user-perms">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!user.isApproved}
                        onChange={(e) => {
                          setAdminUsers((prev) =>
                            prev.map((u) =>
                              u.id === user.id ? { ...u, isApproved: e.target.checked } : u
                            )
                          );
                        }}
                      />{' '}
                      Approved
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={!!user.canLogin}
                        onChange={(e) => {
                          setAdminUsers((prev) =>
                            prev.map((u) =>
                              u.id === user.id ? { ...u, canLogin: e.target.checked } : u
                            )
                          );
                        }}
                      />{' '}
                      Login
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={!!user.canAudioCall}
                        onChange={(e) => {
                          setAdminUsers((prev) =>
                            prev.map((u) =>
                              u.id === user.id ? { ...u, canAudioCall: e.target.checked } : u
                            )
                          );
                        }}
                      />{' '}
                      Audio
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={!!user.canVideoCall}
                        onChange={(e) => {
                          setAdminUsers((prev) =>
                            prev.map((u) =>
                              u.id === user.id ? { ...u, canVideoCall: e.target.checked } : u
                            )
                          );
                        }}
                      />{' '}
                      Video
                    </label>
                  </div>

                  <button
                    className="primary"
                    onClick={async () => {
                      const target = adminUsers.find((u) => u.id === user.id);
                      if (!target) return;

                      const res = await apiFetch(`/api/admin/users/${user.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          isApproved: target.isApproved,
                          canLogin: target.canLogin,
                          canAudioCall: target.canAudioCall,
                          canVideoCall: target.canVideoCall
                        })
                      });

                      const data = await res.json();
                      if (!res.ok) {
                        showError(data.error || 'Failed to update user');
                        return;
                      }

                      setAdminUsers((prev) =>
                        prev.map((u) => (u.id === user.id ? { ...u, ...data.user } : u))
                      );

                      showToast('User permissions updated', 'success');
                    }}
                  >
                    Save
                  </button>
                </div>
              ))}

              {!filteredAdminUsers.length ? (
                <div className="admin-empty">No users found.</div>
              ) : null}
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setAdminOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {groupCreateOpen ? (
        <div className="call-overlay">
          <div className="call-modal admin-modal">
            <div className="call-top">
              <div>
                <div className="call-name">Create Group</div>
                <div className="call-sub">Select members and create a new group chat</div>
              </div>
            </div>

            <div className="settings-body">
              <label className="field">
                <span>Group name</span>
                <input
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  placeholder="Team Chat"
                />
              </label>

              <div className="contact-group-title" style={{ marginBottom: 12 }}>Members</div>

              <div className="admin-user-list">
                {users
                  .filter((u) => u.id !== me.id)
                  .map((user) => (
                    <label
                      key={user.id}
                      className="admin-user-row"
                      style={{ cursor: 'pointer' }}
                    >
                      <div className="admin-user-main">
                        <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                        <div>
                          <div className="contact-name">{user.name}</div>
                          <div className="contact-preview">@{user.userId}</div>
                        </div>
                      </div>

                      <input
                        type="checkbox"
                        checked={groupMemberIds.includes(user.id)}
                        onChange={() => toggleGroupMember(user.id)}
                      />
                    </label>
                  ))}
              </div>

              <div className="settings-actions">
                <button
                  className="primary"
                  onClick={async () => {
                    const res = await apiFetch('/api/groups', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        title: groupTitle,
                        memberIds: groupMemberIds
                      })
                    });

                    const data = await res.json();

                    if (!res.ok) {
                      showError(data.error || 'Failed to create group');
                      return;
                    }

                    socketRef.current?.emit(
                      'users:sync',
                      async (payload: {
                        users: User[];
                        groups?: GroupChat[];
                        onlineUserIds: string[];
                        idleUserIds: string[];
                        groupInvites: GroupInvite[];
                        activeChatTargets?: Record<string, string | null>;
                      }) => {
                        setUsers(payload.users || []);
                        setGroups(payload.groups || []);
                        setOnlineUserIds(payload.onlineUserIds || []);
                        setIdleUserIds(payload.idleUserIds || []);
                        setActiveChatTargets(payload.activeChatTargets || {});
                        setGroupInvites(payload.groupInvites || []);

                        await loadAllHistories(payload.users || [], undefined, payload.groups || []);
                      }
                    );

                    setSelectedChatKind('group');
                    setSelectedGroupId(data.group.id);
                    setGroupCreateOpen(false);
                    setGroupTitle('');
                    setGroupMemberIds([]);
                    showSuccess('Group created');

                    requestAnimationFrame(() => {
                      void loadGroupHistory(data.group.id, true);
                    });
                  }}
                >
                  Create group
                </button>
              </div>
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button
                className="icon-btn wide"
                onClick={() => {
                  setGroupCreateOpen(false);
                  setGroupTitle('');
                  setGroupMemberIds([]);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ImageLightbox
        state={lightbox}
        serverUrl={connectedServerUrl}
        onClose={closeLightbox}
        onPrev={showPrevLightbox}
        onNext={showNextLightbox}
        onSelect={jumpToLightboxIndex}
      />

      {profileOpen ? (
        <div className="call-overlay">
          <div className="call-modal settings-modal">
            <div className="call-top">
              <div>
                <div className="call-name">Change Profile</div>
                <div className="call-sub">Update your avatar and display name</div>
              </div>
            </div>

            <div className="settings-body">
              <div className="settings-avatar-row">
                <UserAvatar user={me} serverUrl={connectedServerUrl} size="large" />
                <label className="primary upload-btn">
                  Upload avatar
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;

                      const form = new FormData();
                      form.append('avatar', file);

                      const res = await apiFetch('/api/profile/avatar', {
                        method: 'POST',
                        body: form
                      });

                      const data = await res.json();
                      if (!res.ok) {
                        showError(data.error || 'Avatar upload failed');
                        return;
                      }

                      setMe(data.user);
                      meRef.current = data.user;
                      setUsers((prev) =>
                        prev.map((u) => (u.id === data.user.id ? { ...u, ...data.user } : u))
                      );
                      showToast('Avatar updated', 'success');
                    }}
                  />
                </label>
              </div>

              <label className="field">
                <span>User ID</span>
                <input value={me.userId} disabled />
              </label>

              <label className="field">
                <span>Display name</span>
                <input value={profileName} onChange={(e) => setProfileName(e.target.value)} />
              </label>

              <div className="settings-actions">
                <button
                  className="primary"
                  onClick={async () => {
                    const res = await apiFetch('/api/profile', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: profileName })
                    });

                    const data = await res.json();
                    if (!res.ok) {
                      showError(data.error || 'Profile update failed');
                      return;
                    }

                    setMe(data.user);
                    meRef.current = data.user;
                    setUsers((prev) =>
                      prev.map((u) => (u.id === data.user.id ? { ...u, ...data.user } : u))
                    );
                    showToast('Profile updated', 'success');
                  }}
                >
                  Save profile
                </button>

                <button
                  className="icon-btn wide"
                  onClick={() => {
                    setProfileOpen(false);
                    setPasswordOpen(true);
                  }}
                >
                  Change password
                </button>
              </div>
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setProfileOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {passwordOpen ? (
        <div className="call-overlay">
          <div className="call-modal settings-modal password-modal">
            <div className="call-top">
              <div>
                <div className="call-name">Change Password</div>
                <div className="call-sub">Update your account password</div>
              </div>
            </div>

            <div className="settings-body">
              <label className="field">
                <span>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </label>

              <label className="field">
                <span>New password</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>

              <label className="field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                />
              </label>

              <div className="settings-actions">
                <button
                  className="primary"
                  onClick={async () => {
                    if (newPassword !== confirmNewPassword) {
                      showError('New passwords do not match');
                      return;
                    }

                    const res = await apiFetch('/api/profile/password', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        currentPassword,
                        newPassword
                      })
                    });

                    const data = await res.json();
                    if (!res.ok) {
                      showError(data.error || 'Password change failed');
                      return;
                    }

                    setCurrentPassword('');
                    setNewPassword('');
                    setConfirmNewPassword('');
                    showToast('Password changed', 'success');
                    setPasswordOpen(false);
                  }}
                >
                  Change password
                </button>
              </div>
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setPasswordOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {groupManageOpen && selectedGroup ? (
        <div className="call-overlay">
          <div className="call-modal admin-modal">
            <div className="call-top">
              <div>
                <div className="call-name">Manage Group</div>
                <div className="call-sub">{selectedGroup.title}</div>
              </div>
            </div>

            <div className="settings-body">
              <div className="group-manage-tabs">
                {canSeeGeneralGroupTab ? (
                  <button
                    className={`group-manage-tab ${groupManageTab === 'general' ? 'active' : ''}`}
                    onClick={() => setGroupManageTab('general')}
                  >
                    General
                  </button>
                ) : null}

                <button
                  className={`group-manage-tab ${groupManageTab === 'members' ? 'active' : ''}`}
                  onClick={() => setGroupManageTab('members')}
                >
                  Members
                </button>
              </div>

              {groupManageTab === 'general' && canSeeGeneralGroupTab ? (
                <>
                  <div className="group-manage-section">
                    <div className="contact-group-title">Group info</div>

                    <div className="settings-avatar-row">
                      <UserAvatar
                        user={{
                          id: selectedGroup.id,
                          userId: selectedGroup.title,
                          name: selectedGroup.title,
                          avatarUrl: selectedGroup.avatarUrl || null
                        }}
                        serverUrl={connectedServerUrl}
                        size="large"
                      />

                      {isGroupAdmin(selectedGroup, me.id) ? (
                        <label className="primary upload-btn">
                          Upload group avatar
                          <input
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              void uploadGroupAvatar(selectedGroup.id, file);
                            }}
                          />
                        </label>
                      ) : null}
                    </div>

                    <label className="field">
                      <span>Group name</span>
                      <input
                        value={groupEditTitle}
                        onChange={(e) => setGroupEditTitle(e.target.value)}
                        disabled={!isGroupAdmin(selectedGroup, me.id)}
                        placeholder="Group name"
                      />
                    </label>

                    {isGroupAdmin(selectedGroup, me.id) ? (
                      <div className="settings-actions">
                        <button
                          className="primary"
                          onClick={() => {
                            void updateGroupTitle(selectedGroup.id, groupEditTitle);
                          }}
                        >
                          Save group name
                        </button>
                      </div>
                    ) : (
                      <div className="contact-preview">
                        Only group admins can change the group name or avatar.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {isGroupOwner(selectedGroup, me.id) ? (
                    <div className="group-manage-section">
                      <div className="contact-group-title">Pending join approvals</div>

                      <div className="admin-user-list">
                        {pendingGroupJoinApprovals.length ? (
                          pendingGroupJoinApprovals.map((user) => (
                            <div key={user.id} className="admin-user-row">
                              <div className="admin-user-main">
                                <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                                <div>
                                  <div className="contact-name">{user.name}</div>
                                  <div className="contact-preview">@{user.userId}</div>
                                </div>
                              </div>

                              <div className="admin-user-perms">
                                <button
                                  className="icon-btn wide"
                                  onClick={() => {
                                    void rejectGroupJoinRequest(selectedGroup.id, user.id);
                                  }}
                                >
                                  Reject
                                </button>

                                <button
                                  className="primary"
                                  onClick={() => {
                                    void approveGroupJoinRequest(selectedGroup.id, user.id);
                                  }}
                                >
                                  Approve
                                </button>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">No pending requests.</div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {isGroupMember(selectedGroup, me.id) ? (
                    <div className="group-manage-section">
                      <div className="contact-group-title">Invite users</div>

                      <div className="admin-user-list">
                        {selectedGroupInviteCandidates.length ? (
                          selectedGroupInviteCandidates.map((user) => (
                            <div key={user.id} className="admin-user-row">
                              <div className="admin-user-main">
                                <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                                <div>
                                  <div className="contact-name">{user.name}</div>
                                  <div className="contact-preview">@{user.userId}</div>
                                </div>
                              </div>

                              <button
                                className="primary"
                                onClick={() => {
                                  void inviteUserToGroup(selectedGroup.id, user.id);
                                }}
                              >
                                Invite
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">No available users to invite.</div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {isGroupMember(selectedGroup, me.id) ? (
                    <div className="group-manage-section group-manage-danger-section">
                      <div className="contact-group-title">
                        {isGroupOwner(selectedGroup, me.id) ? 'Delete group' : 'Leave group'}
                      </div>

                      <div className="contact-preview group-manage-danger-copy">
                        {isGroupOwner(selectedGroup, me.id)
                          ? 'As the owner, you cannot leave this group. Deleting it will remove the group for all members.'
                          : 'Leave this group and stop receiving its messages. The group will remain available for the other members.'}
                      </div>

                      <div className="group-manage-danger-actions">
                        {isGroupOwner(selectedGroup, me.id) ? (
                          <button
                            className="danger wide"
                            onClick={() => {
                              setGroupConfirmDialog({
                                mode: 'delete',
                                groupId: selectedGroup.id,
                                title: selectedGroup.title
                              });
                            }}
                          >
                            Delete group
                          </button>
                        ) : (
                          <button
                            className="danger wide"
                            onClick={() => {
                              setGroupConfirmDialog({
                                mode: 'leave',
                                groupId: selectedGroup.id,
                                title: selectedGroup.title
                              });
                            }}
                          >
                            Leave group
                          </button>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <div className="group-manage-section">
                    <div className="contact-group-title">Members</div>

                    <div className="admin-user-list">
                      {selectedGroupMembers.map((user) => {
                        const isOwner = selectedGroup.ownerUserId === user.id;
                        const isAdminUser = selectedGroup.adminUserIds.includes(user.id);

                        return (
                          <div key={user.id} className="admin-user-row">
                            <div className="admin-user-main">
                              <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                              <div>
                                <div className="contact-name">{user.name}</div>
                                <div className="contact-preview">
                                  @{user.userId}
                                  {isOwner
                                    ? ' · Owner'
                                    : isAdminUser
                                    ? ' · Admin'
                                    : ' · Member'}
                                </div>
                              </div>
                            </div>

                            <div className="admin-user-perms">
                              {isGroupOwner(selectedGroup, me.id) && !isOwner ? (
                                <button
                                  className="icon-btn wide"
                                  onClick={() => {
                                    void setUserAdminRole(
                                      selectedGroup.id,
                                      user.id,
                                      !isAdminUser
                                    );
                                  }}
                                >
                                  {isAdminUser ? 'Remove admin' : 'Make admin'}
                                </button>
                              ) : null}

                              {isGroupAdmin(selectedGroup, me.id) && !isOwner && user.id !== me.id ? (
                                <button
                                  className="danger wide"
                                  onClick={() => {
                                    void removeGroupMember(selectedGroup.id, user.id);
                                  }}
                                >
                                  Remove
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setGroupManageOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      
      <ConfirmModal
  open={!!deleteChatTarget}
  title="Delete chat"
  subtitle={deleteChatTarget ? `Choose how to delete chat with ${deleteChatTarget.name}` : ''}
  onClose={() => setDeleteChatTargetUserId(null)}
  actions={
    <>
      <button className="icon-btn wide" onClick={() => setDeleteChatTargetUserId(null)}>
        Cancel
      </button>
      <button className="icon-btn wide" onClick={clearCurrentConversationForMe}>
        Delete for me
      </button>
      <button className="danger wide" onClick={deleteCurrentConversationForEveryone}>
        Delete for everyone
      </button>
    </>
  }
>
  <>
    Delete for me hides the current chat only on your app.
    <br />
    Delete for everyone removes the chat history for both users.
  </>
      </ConfirmModal>

      <ConfirmModal
        open={!!deleteMessageTarget}
        title="Delete message"
        subtitle="Choose how to delete this message"
        onClose={() => setDeleteMessageTargetId(null)}
        actions={
          <>
            <button className="icon-btn wide" onClick={() => setDeleteMessageTargetId(null)}>
              Cancel
            </button>
            <button className="icon-btn wide" onClick={clearMessageForMe}>
              Delete for me
            </button>
            {deleteMessageTarget?.fromUserId === me.id ? (
              <button className="danger wide" onClick={deleteMessageForEveryone}>
                Delete for everyone
              </button>
            ) : null}
          </>
        }
      >
        <>
          Delete for me hides this message only on your app.
          <br />
          {deleteMessageTarget?.fromUserId === me.id
            ? 'Delete for everyone replaces the message for both users.'
            : 'You can delete this message for yourself.'}
        </>
      </ConfirmModal>

      <ConfirmModal
        open={!!groupConfirmDialog}
        title={groupConfirmDialog?.mode === 'delete' ? 'Delete group' : 'Leave group'}
        subtitle={groupConfirmDialog?.title || ''}
        onClose={() => setGroupConfirmDialog(null)}
        confirmText={groupConfirmDialog?.mode === 'delete' ? 'Delete group' : 'Leave group'}
        confirmClassName="danger wide"
        onConfirm={() => {
          void confirmGroupDangerAction();
        }}
      >
        {groupConfirmDialog?.mode === 'delete'
          ? 'This will permanently remove the group and its messages for all members.'
          : 'You will leave this group and stop receiving its messages. Other members will stay in the group.'}
      </ConfirmModal>

      <ConfirmModal
        open={!!deleteGroupChatTarget}
        title="Delete group chat"
        subtitle={
          deleteGroupChatTarget
            ? `Choose how to delete chat in ${deleteGroupChatTarget.title}`
            : ''
        }
        onClose={() => setDeleteGroupChatTargetId(null)}
        actions={
          <>
            <button className="icon-btn wide" onClick={() => setDeleteGroupChatTargetId(null)}>
              Cancel
            </button>

            <button className="icon-btn wide" onClick={clearCurrentGroupConversationForMe}>
              Delete for me
            </button>

            <button className="icon-btn wide" onClick={deleteOwnGroupMessagesForEveryone}>
              Delete my messages for everyone
            </button>

            {deleteGroupChatTarget && isGroupOwner(deleteGroupChatTarget, me.id) ? (
              <button className="danger wide" onClick={clearGroupChatForEveryone}>
                Clear chat
              </button>
            ) : null}
          </>
        }
      >
        <>
          Delete for me hides this group chat only on your app.
          <br />
          Delete my messages for everyone removes all messages you sent in this group for all members.
          <br />
          {deleteGroupChatTarget && isGroupOwner(deleteGroupChatTarget, me.id)
            ? 'Clear chat removes all group messages for every member.'
            : 'Only the group owner can clear the whole group chat for everyone.'}
        </>
      </ConfirmModal>

      {groupMembersOpen && selectedGroup ? (
        <div className="call-overlay" onClick={() => setGroupMembersOpen(false)}>
          <div
            className="call-modal admin-modal group-members-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="call-top">
              <div>
                <div className="call-name">Group Members</div>
                <div className="call-sub">
                  {selectedGroup.title} · {selectedGroup.memberIds.length} members
                </div>
              </div>
            </div>

            <div className="admin-toolbar">
              <input
                className="admin-search-input"
                value={groupMemberSearch}
                onChange={(e) => setGroupMemberSearch(e.target.value)}
                placeholder="Search members by name or user ID"
              />
            </div>

            <div className="admin-user-list">
              {filteredGroupMembers.length ? (
                filteredGroupMembers.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className="admin-user-row member-row-action"
                    onClick={() => openGroupMemberTarget(user.id)}
                  >
                    <div className="admin-user-main">
                      <UserAvatar user={user} serverUrl={connectedServerUrl} size="small" />
                      <div>
                        <div className="contact-name">
                          {user.name}
                          {user.id === me.id ? ' (You)' : ''}
                        </div>
                        <div className="contact-preview">
                          @{user.userId} · {getGroupRoleLabel(selectedGroup, user.id)}
                        </div>
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="admin-empty">No members found.</div>
              )}
            </div>

            <div className="call-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn wide" onClick={() => setGroupMembersOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={`app-toast ${toast.tone}`} role="status" aria-live="polite">
          <div className="app-toast-content">
            <span className="app-toast-icon">
              {toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '⚠' : 'i'}
            </span>
            <span className="app-toast-message">{toast.message}</span>
          </div>

          <button
            type="button"
            className="app-toast-close"
            onClick={dismissToast}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}