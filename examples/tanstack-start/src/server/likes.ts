"use server";

let likes = 0;

// An islx server action, called from an island. Its arguments come from the browser: check them.
export async function addLike(by: number) {
  if (!Number.isSafeInteger(by) || by < 1 || by > 10) throw new Error("addLike takes 1 to 10");
  likes += by;
  return likes;
}
