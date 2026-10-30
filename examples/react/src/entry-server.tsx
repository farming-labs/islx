import { renderToStream } from "@farm.js/islx/react/server";
import { handleAction, type ReactFormState } from "@farm.js/islx/server";
import Home from "./pages/home";
import Todos from "./pages/todos";

const routes: Record<string, () => Promise<React.ReactNode>> = { "/": Home, "/todos": Todos };

async function page(request: Request, formState?: ReactFormState): Promise<Response> {
  const route = routes[new URL(request.url).pathname];
  if (!route) return new Response("Not Found", { status: 404 });
  const stream = await renderToStream(await route(), { request, formState });
  return new Response(stream, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function handle(request: Request): Promise<Response> {
  const action = await handleAction(request, {
    renderFormState: (formState) => page(request, formState),
  });
  return action ?? page(request);
}
