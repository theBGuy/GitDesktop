/** Owners the viewer can publish a new GitHub repository under. */
export interface GhPublishOwners {
  viewer: string;
  orgs: { login: string; canCreate: boolean }[];
}
