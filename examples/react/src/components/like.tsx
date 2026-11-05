"use client";
import { useState } from "react";

// Sets no `hydrate` export and only reacts to clicks: islx infers "interaction", so a page of
// such islands loads only the boot script until one is clicked.
export function Like() {
  const [likes, setLikes] = useState(0);
  return (
    <button data-testid="like" onClick={() => setLikes(likes + 1)}>
      likes {likes}
    </button>
  );
}
