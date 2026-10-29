"use client";
import { useActionState, useState } from "react";

type Vote = (previous: { votes: number }, form: FormData) => Promise<{ votes: number }>;

export function Votes({ vote }: { vote: Vote }) {
  const [state, action, pending] = useActionState(vote, { votes: 0 });
  return (
    <form action={action}>
      <output data-testid="votes">votes {state.votes}</output>
      <input type="hidden" name="by" value="2" />
      <button data-testid="vote" disabled={pending}>
        Vote
      </button>
    </form>
  );
}

export function Clicks() {
  const [clicks, setClicks] = useState(0);
  return (
    <button data-testid="clicks" onClick={() => setClicks(clicks + 1)}>
      clicks {clicks}
    </button>
  );
}

export function Rename({ rename }: { rename: (title: string) => Promise<string> }) {
  const [result, setResult] = useState("");
  return (
    <button data-testid="rename" onClick={async () => setResult(await rename("from island"))}>
      {result || "rename"}
    </button>
  );
}
