// src/lib/api-auth.ts

import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

export async function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  
  if (!token) {
    return { user: null, error: 'No auth token provided', supabase: null };
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  
  if (error || !user) {
    return { user: null, error: error?.message || 'Invalid token', supabase: null };
  }

  return { user, error: null, supabase };
}
