// Base64 for bytes, the same in Node and in a browser (Buffer exists only in Node).

export function toBase64(data: Uint8Array): string {
  let binary = "";
  // In slices: String.fromCharCode can't take millions of arguments at once.
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
