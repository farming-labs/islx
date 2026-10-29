import type { ReactNode } from "react";

export function Document({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <link rel="icon" href="data:," />
        <title>{title}</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a> <a href="/todos">Todos</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
