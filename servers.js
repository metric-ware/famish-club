// Production exports always connect to Europe, including when previewed locally.
// No connection is opened until the player presses Play.
export function serversForPage() {
  return [{ name: "Famish Europe", url: "wss://eu.famish.club/" }];
}
