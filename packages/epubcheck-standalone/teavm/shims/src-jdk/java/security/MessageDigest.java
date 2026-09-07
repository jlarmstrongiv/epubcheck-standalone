package java.security;

/**
 * TeaVM shim: pure-Java SHA-256 (the only algorithm epubcheck requests --
 * OCFResources.getSHAHash uses MessageDigest.getInstance("SHA-256")).
 * Supplied as classpath bytecode; see java.util.concurrent.locks.Lock.
 */
public abstract class MessageDigest {
    private final String algorithm;

    protected MessageDigest(String algorithm) {
        this.algorithm = algorithm;
    }

    public static MessageDigest getInstance(String algorithm) throws NoSuchAlgorithmException {
        if ("SHA-256".equalsIgnoreCase(algorithm)) {
            return new Sha256Digest();
        }
        throw new NoSuchAlgorithmException(algorithm + " not available in the TeaVM shim");
    }

    public final String getAlgorithm() {
        return algorithm;
    }

    public void update(byte input) {
        engineUpdate(new byte[] { input }, 0, 1);
    }

    public void update(byte[] input) {
        engineUpdate(input, 0, input.length);
    }

    public void update(byte[] input, int offset, int len) {
        engineUpdate(input, offset, len);
    }

    public byte[] digest() {
        return engineDigest();
    }

    public byte[] digest(byte[] input) {
        update(input);
        return digest();
    }

    public void reset() {
        engineReset();
    }

    public int getDigestLength() {
        return engineGetDigestLength();
    }

    protected abstract void engineUpdate(byte[] input, int offset, int len);

    protected abstract byte[] engineDigest();

    protected abstract void engineReset();

    protected abstract int engineGetDigestLength();

    /** FIPS 180-4 SHA-256, streaming. */
    private static final class Sha256Digest extends MessageDigest {
        private static final int[] K = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        };

        private final int[] h = new int[8];
        private final byte[] buffer = new byte[64];
        private int bufferLen;
        private long byteCount;

        Sha256Digest() {
            super("SHA-256");
            engineReset();
        }

        @Override
        protected void engineReset() {
            h[0] = 0x6a09e667;
            h[1] = 0xbb67ae85;
            h[2] = 0x3c6ef372;
            h[3] = 0xa54ff53a;
            h[4] = 0x510e527f;
            h[5] = 0x9b05688c;
            h[6] = 0x1f83d9ab;
            h[7] = 0x5be0cd19;
            bufferLen = 0;
            byteCount = 0;
        }

        @Override
        protected int engineGetDigestLength() {
            return 32;
        }

        @Override
        protected void engineUpdate(byte[] input, int offset, int len) {
            byteCount += len;
            while (len > 0) {
                int n = Math.min(len, 64 - bufferLen);
                System.arraycopy(input, offset, buffer, bufferLen, n);
                bufferLen += n;
                offset += n;
                len -= n;
                if (bufferLen == 64) {
                    processBlock(buffer, 0);
                    bufferLen = 0;
                }
            }
        }

        @Override
        protected byte[] engineDigest() {
            long bitLength = byteCount * 8;
            // Padding: 0x80, zeros, 64-bit big-endian length.
            update((byte) 0x80);
            while (bufferLen != 56) {
                update((byte) 0);
            }
            byte[] lenBytes = new byte[8];
            for (int i = 7; i >= 0; i--) {
                lenBytes[i] = (byte) bitLength;
                bitLength >>>= 8;
            }
            engineUpdate(lenBytes, 0, 8);
            byte[] out = new byte[32];
            for (int i = 0; i < 8; i++) {
                out[i * 4] = (byte) (h[i] >>> 24);
                out[i * 4 + 1] = (byte) (h[i] >>> 16);
                out[i * 4 + 2] = (byte) (h[i] >>> 8);
                out[i * 4 + 3] = (byte) h[i];
            }
            engineReset();
            return out;
        }

        private void processBlock(byte[] block, int offset) {
            int[] w = new int[64];
            for (int i = 0; i < 16; i++) {
                w[i] = ((block[offset + i * 4] & 0xff) << 24)
                        | ((block[offset + i * 4 + 1] & 0xff) << 16)
                        | ((block[offset + i * 4 + 2] & 0xff) << 8)
                        | (block[offset + i * 4 + 3] & 0xff);
            }
            for (int i = 16; i < 64; i++) {
                int s0 = Integer.rotateRight(w[i - 15], 7) ^ Integer.rotateRight(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                int s1 = Integer.rotateRight(w[i - 2], 17) ^ Integer.rotateRight(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = w[i - 16] + s0 + w[i - 7] + s1;
            }
            int a = h[0];
            int b = h[1];
            int c = h[2];
            int d = h[3];
            int e = h[4];
            int f = h[5];
            int g = h[6];
            int hh = h[7];
            for (int i = 0; i < 64; i++) {
                int s1 = Integer.rotateRight(e, 6) ^ Integer.rotateRight(e, 11) ^ Integer.rotateRight(e, 25);
                int ch = (e & f) ^ (~e & g);
                int temp1 = hh + s1 + ch + K[i] + w[i];
                int s0 = Integer.rotateRight(a, 2) ^ Integer.rotateRight(a, 13) ^ Integer.rotateRight(a, 22);
                int maj = (a & b) ^ (a & c) ^ (b & c);
                int temp2 = s0 + maj;
                hh = g;
                g = f;
                f = e;
                e = d + temp1;
                d = c;
                c = b;
                b = a;
                a = temp1 + temp2;
            }
            h[0] += a;
            h[1] += b;
            h[2] += c;
            h[3] += d;
            h[4] += e;
            h[5] += f;
            h[6] += g;
            h[7] += hh;
        }
    }
}
