import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zakura",
  description: "AI environment orchestration & unified MCP gateway",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={cn(geist.variable, geistMono.variable)}
    >
      <body className="min-h-svh font-sans antialiased">
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <Toaster position="top-center" closeButton />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
