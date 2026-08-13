"use client";

import { Component, useEffect, type ReactNode } from "react";
import { initWebOtel, reportClientError } from "@/lib/otel";

class OtelErrorBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error): void {
    reportClientError("client.react", error, { kind: "error-boundary" });
  }

  render(): ReactNode {
    return this.props.children;
  }
}

export function OtelProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    initWebOtel();
  }, []);
  return <OtelErrorBoundary>{children}</OtelErrorBoundary>;
}
