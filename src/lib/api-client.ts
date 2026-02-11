// src/lib/api-client.ts

import { supabase } from './supabase';

export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const { data: { session }, error } = await supabase.auth.getSession();
  
  console.log('Auth session:', !!session, 'Error:', error?.message);
  console.log('Access token:', session?.access_token ? 'Present' : 'Missing');
  
  if (!session?.access_token) {
    console.error('No access token available!');
  }
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
    ...(session?.access_token && {
      'Authorization': `Bearer ${session.access_token}`
    }),
  };

  console.log('Headers being sent:', Object.keys(headers));

  return fetch(url, {
    ...options,
    headers,
  });
}
