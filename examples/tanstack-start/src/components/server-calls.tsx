"use client";
import { useState } from "react";
import { getServerTime } from "../server/time";
import { addLike } from "../server/likes";

export function ServerCalls() {
  const [time, setTime] = useState("");
  const [likes, setLikes] = useState<number | null>(null);
  return (
    <div>
      <button type="button" onClick={async () => setTime((await getServerTime()).iso)}>
        Server time
      </button>
      <output data-testid="time">{time}</output>
      <button type="button" onClick={async () => setLikes(await addLike(2))}>
        Like twice
      </button>
      <output data-testid="likes">{likes ?? ""}</output>
    </div>
  );
}
