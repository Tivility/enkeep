export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';
export type UserLocale = 'en' | 'zh-CN';
export const SUPPORTED_LOCALES: readonly UserLocale[] = ['en', 'zh-CN'] as const;
export const DEFAULT_USER_LOCALE: UserLocale = 'en';

export function isValidUserLocale(value: unknown): value is UserLocale {
  return value === 'en' || value === 'zh-CN';
}

export type UserTheme = 'dark' | 'light' | 'eye-care';
export const SUPPORTED_THEMES: readonly UserTheme[] = ['dark', 'light', 'eye-care'] as const;
export const DEFAULT_USER_THEME: UserTheme = 'dark';

export function isValidUserTheme(value: unknown): value is UserTheme {
  return value === 'dark' || value === 'light' || value === 'eye-care';
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  displayName?: string | null;
  locale: UserLocale;
  theme: UserTheme;
  mustChangePassword?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  id?: string;
  username: string;
  passwordHash: string;
  role?: UserRole;
  status?: UserStatus;
  displayName?: string | null;
  locale?: UserLocale;
  theme?: UserTheme;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  passwordHash?: string;
  role?: UserRole;
  status?: UserStatus;
  displayName?: string | null;
  locale?: UserLocale;
  theme?: UserTheme;
  mustChangePassword?: boolean;
}

import type { ExecutionMode } from './space.js';

export interface FixtureProvisionOptions {
  adminUsername?: string;
  adminPassword?: string;
  userUsername?: string;
  userPassword?: string;
  disabledUsername?: string;
  disabledPassword?: string;
}

export interface FixtureProvisionResult {
  admin: User;
  adminContainerSpace: {
    id: string;
    name: string;
    folder: string;
    executionMode: ExecutionMode;
  };
  adminSpace: {
    id: string;
    name: string;
    folder: string;
    executionMode: ExecutionMode;
  };
  user: User;
  userContainerSpace: {
    id: string;
    name: string;
    folder: string;
    executionMode: ExecutionMode;
  };
  userSpace: {
    id: string;
    name: string;
    folder: string;
    executionMode: ExecutionMode;
  };
  disabledUser: User;
}

