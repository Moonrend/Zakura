import { NetworkSubnav } from "@/components/network-subnav";

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <NetworkSubnav />
      {children}
    </div>
  );
}
