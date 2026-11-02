import { useEffect, useRef, type ReactNode } from 'react';
import { X, Search, LoaderCircle, Cat, Check } from 'lucide-react';

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`}>
      <Cat size={small ? 21 : 29} strokeWidth={1.6} />
      <span>LightMao</span>
    </span>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={18} />;
}
export function SearchBox({
  value,
  onChange,
  placeholder = '搜索…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="searchbox">
      <Search size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button aria-label="清空搜索" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${checked ? 'on' : ''}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    element?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && element) {
        const nodes = Array.from(
          element.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ),
        );
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭对话框">
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`status ${tone}`}>
      <i />
      {children}
    </span>
  );
}
export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      <Check size={17} />
      {text}
    </div>
  );
}
export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export const formatTime = (s: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).format(new Date(s));
