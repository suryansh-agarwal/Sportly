import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '../../lib/supabase';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) Alert.alert('Sign in failed', error.message);
  }

  return (
    <View className="flex-1 justify-center gap-3 bg-white p-6">
      <Text className="mb-4 text-3xl font-bold text-emerald-600">Sportly</Text>
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
          {busy ? 'Signing in…' : 'Sign in'}
        </Text>
      </Pressable>
      <Link href="/sign-up" className="mt-2 text-center text-emerald-700">
        New here? Create an account
      </Link>
    </View>
  );
}
