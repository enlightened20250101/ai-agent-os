import type { Metadata } from "next";
import { Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-sans"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: "AI Agent OS",
  description: "監査を重視した AI エージェントワークフロー"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className={`${manrope.variable} ${jetbrainsMono.variable}`}>
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}
