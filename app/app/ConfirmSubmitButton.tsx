"use client";

type ConfirmSubmitButtonProps = {
  label: string;
  confirmMessage: string;
  className?: string;
};

export function ConfirmSubmitButton({ label, confirmMessage, className }: ConfirmSubmitButtonProps) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {label}
    </button>
  );
}

