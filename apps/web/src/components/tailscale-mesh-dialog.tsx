"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TailscaleMeshPanel } from "@/components/tailscale-mesh-panel";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
};

/** 轻量弹窗壳，内容复用 TailscaleMeshPanel */
export function TailscaleMeshDialog({ open, onOpenChange, onConnected }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Tailscale</DialogTitle>
        </DialogHeader>
        {open ? (
          <TailscaleMeshPanel
            compact
            onConnected={() => {
              onConnected?.();
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
