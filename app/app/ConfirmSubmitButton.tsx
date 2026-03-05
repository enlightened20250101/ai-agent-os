"use client";

import { useFormStatus } from "react-dom";

type ConfirmSubmitButtonProps = {
  label: string;
  confirmMessage: string;
  pendingLabel?: string;
  className?: string;
  name?: string;
  value?: string;
};

export function ConfirmSubmitButton({
  label,
  confirmMessage,
  pendingLabel,
  className,
  name,
  value
}: ConfirmSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
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
