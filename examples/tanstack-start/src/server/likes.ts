"use server";

let likes = 0;

// An islx server action, called from an island.
export async function addLike(by: number) {
  likes += by;
  return likes;
}
