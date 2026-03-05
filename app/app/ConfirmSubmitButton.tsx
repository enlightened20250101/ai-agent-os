"use client";

import { useFormStatus } from "react-dom";

type ConfirmSubmitButtonProps = {
  label: string;
  confirmMessage: string;
  pendingLabel?: string;
  className?: string;
};

export function ConfirmSubmitButton({ label, confirmMessage, pendingLabel, className }: ConfirmSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${className ?? ""} ${pending ? "cursor-not-allowed opacity-60" : ""}`.trim()}
      disabled={pending}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {pending ? pendingLabel ?? "実行中..." : label}
    </button>
  );
}
