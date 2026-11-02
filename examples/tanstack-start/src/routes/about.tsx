import { createFileRoute } from "@tanstack/react-router";
import { Counter } from "../components/counter";
import { ServerCalls } from "../components/server-calls";

export const Route = createFileRoute("/about")({
  head: () => ({ meta: [{ title: "About islx on TanStack Start" }] }),
  component: () => (
    <section>
      <h1>About</h1>
      <Counter start={10} label="About" />
      <ServerCalls />
    </section>
  ),
});
