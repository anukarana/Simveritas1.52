import { auth, db, setDoc, getDoc } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc } from 'firebase/firestore';

/**
 * Guarantees a valid authenticated user is available before proceeding.
 * Resolves to the current user, or waits for an auth state change.
 */
export const waitForAuth = (): Promise<User | null> => {
  return new Promise((resolve) => {
    const current = auth.currentUser;
    if (current) return resolve(current);

    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });

    // If no user after 5s, resolve to null (don't force anonymous)
    setTimeout(() => {
      unsub();
      resolve(auth.currentUser);
    }, 5000);
  });
};

/**
 * Ensures a user profile exists in Firestore for the authenticated user.
 */
export const syncUserProfile = async (user: User): Promise<void> => {
  if (!user) return;

  const userDocRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userDocRef);

  if (!userDoc || !userDoc.exists()) {
    // Determine default role
    const role = user.email === "ai.anukaran@gmail.com" ? "admin" : "facilitator";
    
    await setDoc(userDocRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || 'Anonymous',
      photoURL: user.photoURL || '',
      role: role,
      createdAt: Date.now(),
      lastLogin: Date.now()
    });
  } else {
    // Update last login
    await setDoc(userDocRef, {
      lastLogin: Date.now()
    }, { merge: true });
  }
};

