import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ichorous web",
  description:
    "Ichorous, statically recompiled from the original x64 Ichorous.exe to WebAssembly — no emulator, no interpreter.",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-black">{children}</body>
    </html>
  );
}
