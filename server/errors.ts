// A message written for the person using the app. The API shows these as-is
// and replaces any other error's message with a generic one, so internal
// details (paths, SQL, stack-ish text) never reach the page.
export class UserError extends Error {}
