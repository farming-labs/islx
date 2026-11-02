import { createFileRoute } from "@tanstack/react-router";
import { Counter } from "../components/counter";

// Server-only: never reaches the browser in islands mode.
const SERVER_MARKER = "rendered-on-the-server-only";

export const Route = createFileRoute("/")({
  loader: async () => ({ greeting: `Hello from the loader (${SERVER_MARKER.length})` }),
  component: Home,
});

function Home() {
  const { greeting } = Route.useLoaderData();
  return (
    <section>
      <h1>{greeting}</h1>
      <Counter start={2} label="Home" />
    </section>
  );
}
