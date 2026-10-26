"use client";

import { useParams } from "next/navigation";
import { ServerComputerControls } from "@/components/server-computer-controls";

export default function SpaceComputerPage() {
  const { id } = useParams<{ id: string }>();
  return <ServerComputerControls key={id} spaceId={id} />;
}
