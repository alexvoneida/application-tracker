import {
  useEffect,
  useRef,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type HTMLAttributes,
  type MouseEvent,
} from "react";
import { X, LoaderCircle } from "lucide-react";
import type { Stage } from "../shared/model";

export function Badge({ stage }: { stage: Stage }) {
  return (
    <span className={`badge badge-${stage.toLowerCase()}`}>
      <span />
      {stage}
    </span>
  );
}
export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);
  const titleId = useId();
  // A drag that starts inside the dialog and ends on the backdrop also fires a
  // click on the <dialog>, so both the press and the release must be outside.
  const onBackdrop = (e: MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return (
      e.target === ref.current &&
      (e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom)
    );
  };
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? "modal wide" : "modal"}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = onBackdrop(e);
      }}
      onClick={(e) => {
        if (pressedOnBackdrop.current && onBackdrop(e)) close();
        pressedOnBackdrop.current = false;
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
  full = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  full?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${full ? "full" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {isValidElement<HTMLAttributes<HTMLElement>>(children)
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">↗</div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Busy({ text = "Working…" }: { text?: string }) {
  return (
    <span className="busy">
      <LoaderCircle size={15} className="spin" />
      {text}
    </span>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
