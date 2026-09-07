package ecshim;

import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/**
 * TeaVM compiler plugin (auto-discovered via
 * META-INF/services/org.teavm.vm.spi.TeaVMPlugin): installs the
 * BitmapChecker.getImageSizes() body replacement.
 */
public class EcShimPlugin implements TeaVMPlugin {
    @Override
    public void install(TeaVMHost host) {
        host.add(new BitmapCheckerTransformer());
        host.add(new JaxpWiringTransformer());
    }
}
