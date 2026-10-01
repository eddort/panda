//! The complete unsafe boundary: same BLST primitives as min_pk::SecretKey::sign.
//! This value holds only a public point; it never contains or owns secret material.
use super::Context;
use blst::{blst_hash_to_g2, blst_p2, blst_p2_affine, blst_scalar, blst_sign_pk2_in_g1,
    min_pk::{SecretKey, Signature}};

#[derive(Clone, Copy)]
pub(super) struct PublicHash { point: blst_p2 }

impl PublicHash {
    pub(super) fn new(context: &Context) -> Self {
        let mut point = blst_p2::default();
        // SAFETY: all pointers refer to live initialized slices with their exact lengths.
        // BLST writes a full G2 point into the correctly typed, exclusive output. This is
        // the same hash operation/argument order as BLST 0.3.17 SecretKey::sign.
        unsafe {
            blst_hash_to_g2(&mut point, context.root.as_ptr(), context.root.len(),
                context.dst.as_ptr(), context.dst.len(),
                context.augmentation.as_ptr(), context.augmentation.len());
        }
        Self { point }
    }

    pub(super) fn sign(&self, secret: &SecretKey) -> Signature {
        let scalar: &blst_scalar = secret.into();
        let mut signature = blst_p2_affine::default();
        // SAFETY: self.point was created only by hash_to_g2 and is immutable. scalar is
        // BLST's supported borrowed view of the live SecretKey, not a copied secret.
        // The exclusive affine output has the required type/size. A null byte output is
        // expressly supported and is also used by SecretKey::sign. Keep the exact same
        // secret signing primitive; no public MSM or alternate scalar multiplication.
        unsafe {
            blst_sign_pk2_in_g1(std::ptr::null_mut(), &mut signature, &self.point, scalar);
        }
        Signature::from(signature)
    }
}
