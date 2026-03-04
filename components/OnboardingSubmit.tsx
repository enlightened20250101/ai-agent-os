"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      disabled={pending}
    >
      {pending ? "Creating workspace..." : "Continue"}
    </button>
  );
}

export function OnboardingSubmit() {
  const hasSubmittedRef = useRef(false);

  useEffect(() => {
    if (hasSubmittedRef.current) {
      return;
    }

    const form = document.getElementById("onboarding-form") as HTMLFormElement | null;
    form?.requestSubmit();
    hasSubmittedRef.current = true;
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        We are creating your initial organization and owner membership.
      </p>
      <SubmitButton />
    </div>
  );
}
