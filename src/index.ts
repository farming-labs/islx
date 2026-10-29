/**
 * furrow: the wire format. Names, tags and the typed-value codec, shared by the server
 * (`furrow/server`), the browser (`furrow/client`) and every adapter.
 */
export * from "./protocol/wire";
export {
  EncodeError,
  NOT_A_VALUE,
  decode,
  decodeTagged,
  encode,
  encodeLeaf,
  fromBase64,
  needsObjectTag,
  plainObject,
  tagged,
  toBase64,
  type DecodeOptions,
  type EncodeOptions,
} from "./protocol/codec";
