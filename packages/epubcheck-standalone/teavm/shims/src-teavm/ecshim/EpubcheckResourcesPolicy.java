package ecshim;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.teavm.extension.spi.resources.DefaultResourcesPolicy;

/**
 * Selects the classpath resources embedded into the TeaVM bundle. The
 * allowlist (ecshim/resources-allowlist.txt) holds exact resource names,
 * pre-expanded from the GraalVM build's reachability-metadata.json resource
 * globs plus the resource-bundle families build.ts passes to
 * -H:IncludeResourceBundles -- i.e. exactly the resource set the
 * parity-verified wasm build ships.
 *
 * NOTE the SPI contract: supplyResources receives the set of reachable CLASS
 * names (see ClassLoaderNativeGenerator); the return value is the list of
 * resource paths to embed, and unknown paths are skipped silently, so the
 * allowlist can be generous. Registered via
 * META-INF/services/org.teavm.extension.spi.resources.ResourcesPolicy.
 */
public class EpubcheckResourcesPolicy extends DefaultResourcesPolicy {
    @Override
    public String[] supplyResources(Collection<? extends String> reachableClassNames) {
        List<String> out = new ArrayList<>();
        try (InputStream in = EpubcheckResourcesPolicy.class
                .getResourceAsStream("/ecshim/resources-allowlist.txt")) {
            if (in == null) {
                throw new IllegalStateException("ecshim/resources-allowlist.txt missing from shim jar");
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                out.add(line);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toArray(new String[0]);
    }
}
