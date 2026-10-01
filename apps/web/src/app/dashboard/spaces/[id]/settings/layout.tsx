"use client";

import { useParams } from "next/navigation";
import SpaceSettingsLayout from "@/components/space-settings-layout";

export default function SpaceSettingsRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { id } = useParams<{ id: string }>();
  return (
    <SpaceSettingsLayout spaceId={id}>{children}</SpaceSettingsLayout>
  );
}
