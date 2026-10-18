"use client";

import { useParams } from "next/navigation";
import { ComputerCatalog } from "@/components/computer-catalog";

export default function SpaceComputersPage() {
  const { id } = useParams<{ id: string }>();
  return <ComputerCatalog spaceId={id} />;
}
