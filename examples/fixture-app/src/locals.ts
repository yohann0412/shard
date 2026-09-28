/** The signed-in user, as loaded from the session cookie. */
export interface User {
  id: number;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Locals {
      user?: User;
      sessionId?: string;
      maintenance?: boolean;
    }
  }
}
