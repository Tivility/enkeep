import type {
  PlatformStorage,
  AuthService,
  FixtureProvisionOptions,
  FixtureProvisionResult,
} from '@enkeep/platform-core';

export type { FixtureProvisionOptions, FixtureProvisionResult };

export async function provisionFixtures(
  storage: PlatformStorage,
  authService: AuthService,
  options: FixtureProvisionOptions
): Promise<FixtureProvisionResult> {
  if (
    !options ||
    typeof options.adminPassword !== 'string' ||
    options.adminPassword.length === 0 ||
    typeof options.userPassword !== 'string' ||
    options.userPassword.length === 0 ||
    typeof options.disabledPassword !== 'string' ||
    options.disabledPassword.length === 0
  ) {
    throw new Error('provisionFixtures requires explicit non-empty adminPassword, userPassword, and disabledPassword');
  }

  const adminUsername = options.adminUsername ?? 'alice';
  const adminPassword = options.adminPassword;
  const userUsername = options.userUsername ?? 'bob';
  const userPassword = options.userPassword;
  const disabledUsername = options.disabledUsername ?? 'charlie_disabled';
  const disabledPassword = options.disabledPassword;

  // Provision Admin (Alice)
  let admin = await storage.users.findByUsername(adminUsername);
  if (!admin) {
    const passwordHash = await authService.hashPassword(adminPassword);
    admin = await storage.users.create({
      username: adminUsername,
      passwordHash,
      role: 'admin',
      status: 'active',
      displayName: 'Alice (Admin)',
    });
  }

  // Provision Alice spaces
  const aliceTenant = storage.forTenant(admin.id);
  const aliceFolder = 'space-00000000000000000000000000000001';
  let adminContainerSpace = await aliceTenant.spaces.findByFolder(aliceFolder);
  if (!adminContainerSpace) {
    adminContainerSpace = await aliceTenant.spaces.create({
      name: 'Alice Container Space',
      folder: aliceFolder,
    });
  }

  // Provision Regular User (Bob)
  let user = await storage.users.findByUsername(userUsername);
  if (!user) {
    const passwordHash = await authService.hashPassword(userPassword);
    user = await storage.users.create({
      username: userUsername,
      passwordHash,
      role: 'user',
      status: 'active',
      displayName: 'Bob (User)',
    });
  }

  // Provision Bob spaces
  const bobTenant = storage.forTenant(user.id);
  const bobFolder = 'space-00000000000000000000000000000002';
  let userContainerSpace = await bobTenant.spaces.findByFolder(bobFolder);
  if (!userContainerSpace) {
    userContainerSpace = await bobTenant.spaces.create({
      name: 'Bob Container Space',
      folder: bobFolder,
    });
  }

  // Provision Disabled User (Charlie)
  let disabledUser = await storage.users.findByUsername(disabledUsername);
  if (!disabledUser) {
    const passwordHash = await authService.hashPassword(disabledPassword);
    disabledUser = await storage.users.create({
      username: disabledUsername,
      passwordHash,
      role: 'user',
      status: 'disabled',
      displayName: 'Charlie (Disabled)',
    });
  }

  const adminSpaceObj = {
    id: adminContainerSpace.id,
    name: adminContainerSpace.name,
    folder: adminContainerSpace.folder,
    executionMode: adminContainerSpace.executionMode,
  };
  const userSpaceObj = {
    id: userContainerSpace.id,
    name: userContainerSpace.name,
    folder: userContainerSpace.folder,
    executionMode: userContainerSpace.executionMode,
  };

  return {
    admin,
    adminContainerSpace: adminSpaceObj,
    adminSpace: adminSpaceObj,
    user,
    userContainerSpace: userSpaceObj,
    userSpace: userSpaceObj,
    disabledUser,
  };
}
