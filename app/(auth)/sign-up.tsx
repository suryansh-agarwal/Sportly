import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { z } from 'zod';
import { supabase } from '../../lib/supabase';

const schema = z.object({
  username: z.string().regex(/^[a-z0-9_]{3,20}$/, '3-20 chars: a-z, 0-9, _'),
  email: z.string().email(),
  password: z.string().min(8, 'At least 8 characters'),
});

export default function SignUp() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const parsed = schema.safeParse({ username, email, password });
    if (!parsed.success) {
      Alert.alert('Invalid input', parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: { data: { username: parsed.data.username, display_name: parsed.data.username } },
    });
    setBusy(false);
    if (error) Alert.alert('Sign up failed', error.message);
  }

  return (
    <View className="flex-1 justify-center gap-3 bg-white p-6">
      <Text className="mb-4 text-3xl font-bold text-emerald-600">Join Sportly</Text>
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="username"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="rounded-lg border border-gray-300 p-3"
        placeholder="password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        className="mt-2 rounded-lg bg-emerald-600 p-4"
        disabled={busy}
        onPress={onSubmit}
      >
        <Text className="text-center font-semibold text-white">
          {busy ? 'Creating account…' : 'Sign up'}
        </Text>
      </Pressable>
      <Link href="/sign-in" className="mt-2 text-center text-emerald-700">
        Already have an account? Sign in
      </Link>
    </View>
  );
}
