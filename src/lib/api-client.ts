// src/lib/api-client.ts

import { supabase } from './supabase';

export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  
  const headers = {
    'Content-Type': 'application/json',
    ...(session?.access_token && {
      'Authorization': `Bearer ${session.access_token}`
    }),
    ...options.headers,
  };

  return fetch(url, {
    ...options,
    headers,
  });
}
