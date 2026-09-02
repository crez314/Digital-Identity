import { Global, Module } from '@nestjs/common';
import { MlClient } from './ml.client';

@Global()
@Module({ providers: [MlClient], exports: [MlClient] })
export class MlModule {}
