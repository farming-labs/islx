import type { ReactNode } from "react";
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { title: "islx on TanStack Start" }] }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link> <Link to="/about">About</Link> <Link to="/stream">Stream</Link>
        </nav>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
