"use client";

import { Github } from "lucide-react";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.2 2.8-2.5 3.6v3h4c2.4-2.2 3.5-5.4 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1 7.9-2.8l-4-3c-1.1.8-2.5 1.2-3.9 1.2-3 0-5.6-2-6.5-4.8H1.3v3.1C3.3 21.4 7.4 24 12 24z" />
      <path fill="#FBBC05" d="M5.5 14.6c-.2-.7-.4-1.4-.4-2.1s.1-1.5.4-2.1V7.3H1.3C.5 8.8 0 10.4 0 12.5s.5 3.7 1.3 5.2l4.2-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.7l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.3 2.6 1.3 6.5l4.2 3.1C6.4 6.8 9 4.8 12 4.8z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M13 1h10v10H13z" />
      <path fill="#00A4EF" d="M1 13h10v10H1z" />
      <path fill="#FFB900" d="M13 13h10v10H13z" />
    </svg>
  );
}

export function OauthProviderIcon({ id }: { id: string }) {
  if (id === "google") return <GoogleMark />;
  if (id === "github") return <Github className="size-5" />;
  if (id === "microsoft") return <MicrosoftMark />;
  return (
    <span className="text-xs font-semibold tracking-tight">
      {id.slice(0, 2).toUpperCase()}
    </span>
  );
}
