import { ApplicationConfig } from "@angular/core";
import { provideHttpClient, withFetch } from "@angular/common/http";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(withFetch()), provideAnimationsAsync()]
};

