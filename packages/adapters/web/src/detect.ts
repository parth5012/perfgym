import { detectWebProfile } from "./profile.js";

export { detectWebProfile };

export function detectWebProfileName(root: string): string {
  return detectWebProfile(root).name;
}